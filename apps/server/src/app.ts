import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ScanInput,
  TrackInput,
  ProjectPatch,
  ContextInput,
  LocateInput,
  MarkInput,
  ToggleInput,
  DeleteInput,
  PageInput,
} from "@bip/shared";
import { openDatabase } from "./db.js";
import { Projects } from "./projects.js";
import { directorySuggestions, dataHome } from "./paths.js";
import { log, git } from "./git.js";
import { backup } from "./backup.js";
import { agents, doctor } from "./doctor.js";
export function createApp(
  options: {
    home?: string;
    fsHome?: string;
    port?: number;
    token?: string;
    dev?: boolean;
    noAuth?: boolean;
  } = {},
) {
  const home = options.home || dataHome(),
    port = options.port || Number(process.env.BIP_PORT || 4310),
    dev = options.dev ?? process.env.NODE_ENV === "development";
  const token = options.token || randomBytes(32).toString("hex");
  const noAuth = dev && (options.noAuth ?? process.env.BIP_DEV_NO_AUTH === "1");
  const db = openDatabase(home);
  const projects = new Projects(db, options.fsHome || os.homedir());
  const app = new Hono();
  const error = (code: string, message: string, hint?: string) => ({
    error: { code, message, ...(hint ? { hint } : {}) },
  });
  app.onError((e, c) => {
    const status =
      e instanceof z.ZodError
        ? 400
        : (e as Error & { status?: number }).status || 400;
    return c.json(
      error(
        e instanceof z.ZodError ? "VALIDATION_ERROR" : "REQUEST_FAILED",
        e.message,
        "Check the input and folder permissions, then try again.",
      ),
      status as 400,
    );
  });
  app.use("*", async (c, next) => {
    const host = c.req.header("host") || new URL(c.req.url).host;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const allowed = [
      ...hosts,
      ...(dev ? ["127.0.0.1:5173", "localhost:5173"] : []),
    ];
    if (!hosts.includes(host))
      return c.json(error("BAD_HOST", "Host is not allowed"), 403);
    const origin = c.req.header("origin");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      origin &&
      !allowed.map((h) => `http://${h}`).includes(origin)
    )
      return c.json(error("BAD_ORIGIN", "Origin is not allowed"), 403);
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.path.startsWith("/api/")) {
      c.header("Cache-Control", "no-store");
      if (!noAuth && getCookie(c, "bip_session") !== token)
        return c.json(
          error(
            "UNAUTHORIZED",
            "Open the session URL printed in your terminal",
          ),
          401,
        );
    }
    await next();
  });
  app.get("/", async (c, next) => {
    const supplied = c.req.query("token");
    if (supplied) {
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return c.json(error("UNAUTHORIZED", "Invalid session token"), 401);
      setCookie(c, "bip_session", token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
      });
      return c.redirect(dev ? "http://127.0.0.1:5173/" : "/");
    }
    await next();
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/fs/dirs", async (c) =>
    c.json(
      await directorySuggestions(
        c.req.query("prefix") || "",
        options.fsHome || os.homedir(),
      ),
    ),
  );
  app.post("/api/scan", async (c) => {
    const b = ScanInput.parse(await c.req.json());
    return c.json(await projects.scan(b.root, b.depth));
  });
  app.get("/api/tracked-dirs", (c) => c.json(projects.dirs()));
  app.post("/api/tracked-dirs", async (c) => {
    const b = ScanInput.parse(await c.req.json());
    return c.json(await projects.addDir(b.root, b.depth));
  });
  app.delete("/api/tracked-dirs", async (c) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(await c.req.json());
    db.prepare("DELETE FROM tracked_dirs WHERE id=?").run(id);
    return c.json({ ok: true });
  });
  app.get("/api/projects", async (c) => {
    if (c.req.query("rescan") === "1") await projects.rescan();
    return c.json(await projects.list());
  });
  app.post("/api/projects", async (c) =>
    c.json(await projects.track(TrackInput.parse(await c.req.json()).paths)),
  );
  app.get("/api/projects/:id", async (c) =>
    c.json(await projects.row(c.req.param("id"))),
  );
  app.patch("/api/projects/:id", async (c) => {
    const s = await projects.store(c.req.param("id"));
    await s.updateProject(ProjectPatch.parse(await c.req.json()));
    return c.json(await projects.row(c.req.param("id")));
  });
  app.post("/api/projects/:id/untrack", async (c) => {
    await projects.untrack(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/projects/:id/locate", async (c) =>
    c.json(
      await projects.locate(
        c.req.param("id"),
        LocateInput.parse(await c.req.json()).path,
      ),
    ),
  );
  app.delete("/api/projects/:id/bip-data", async (c) => {
    await projects.deleteData(
      c.req.param("id"),
      DeleteInput.parse(await c.req.json()).confirmName,
    );
    return c.json({ ok: true });
  });
  app.get("/api/projects/:id/commits", async (c) =>
    c.json(
      await log(
        await projects.safe(projects.get(c.req.param("id")).path),
        PageInput.parse(c.req.query()),
      ),
    ),
  );
  app.post("/api/projects/:id/mark-shared", async (c) => {
    const { sha } = MarkInput.parse(await c.req.json());
    const s = await projects.store(c.req.param("id"));
    await git(s.repo, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    const date = (
      await git(s.repo, ["show", "-s", "--format=%cI", sha])
    ).trim();
    await s.updateProject({ lastSharedCommit: sha, lastSharedDate: date });
    return c.json(await projects.row(c.req.param("id")));
  });
  app.get("/api/projects/:id/context", async (c) =>
    c.json(await (await projects.store(c.req.param("id"))).readContext()),
  );
  app.put("/api/projects/:id/context", async (c) => {
    const body = ContextInput.parse(await c.req.json());
    await (await projects.store(c.req.param("id"))).writeContext(body);
    return c.json({ ok: true });
  });
  app.post("/api/projects/:id/commit-context", async (c) => {
    const { enabled } = ToggleInput.parse(await c.req.json());
    const s = await projects.store(c.req.param("id"));
    await (enabled ? s.optInCommitContext() : s.optOut());
    return c.json(await projects.row(c.req.param("id")));
  });
  app.post("/api/projects/:id/backup", async (c) => {
    const s = await projects.store(c.req.param("id"));
    return c.json(await backup(home, s.project.id, s.repo));
  });
  app.get("/api/doctor", async (c) =>
    c.json(
      await doctor(
        home,
        port,
        true,
        projects.registry().map((r) => r.path),
      ),
    ),
  );
  app.get("/api/agents/status", async (c) => c.json(await agents()));
  app.all("/api/*", (c) =>
    c.json(error("NOT_FOUND", "API route not found"), 404),
  );
  const web = fileURLToPath(new URL("../../web/dist", import.meta.url));
  app.use("*", serveStatic({ root: web }));
  app.get("*", serveStatic({ path: web + "/index.html" }));
  return {
    app,
    token,
    port,
    projects,
    db,
    async close() {
      await projects.close();
      db.close();
    },
  };
}
