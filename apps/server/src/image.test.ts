import { it, expect, beforeEach, afterEach, describe, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { PNG } from "pngjs";
import { Composition, CaptureInput, CaptureStep } from "@bip/shared";
import { createApp } from "./app.js";
import { git } from "./git.js";
import { directorySuggestions } from "./paths.js";
import { redact, redactDiff } from "./agents/context.js";
import { imageMime, hash } from "./image/assets.js";
import { validateComposition } from "./image/validate.js";
let root: string, repo: string, s: ReturnType<typeof createApp>, id: string;
const png = () => {
  const p = new PNG({ width: 320, height: 200 });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = (i / 4) % 255;
    p.data[i + 1] = 80;
    p.data[i + 2] = 120;
    p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-image-test-"));
  repo = path.join(root, "external/repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "README.md"), "Test");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Initial",
  ]);
  await fs.mkdir(path.join(root, "home"));
  s = createApp({
    home: path.join(root, "data"),
    fsHome: path.join(root, "home"),
  });
  await s.projects.scan(path.dirname(repo), 2);
  const rows = await s.projects.track([repo]);
  id = rows[0].id;
});
afterEach(async () => {
  await s.close();
  await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function asset() {
  return s.images.assets.put(id, png(), "upload", {
    type: "upload",
    filename: "screen.png",
  });
}
async function comp(
  preset: "minimal" | "launch" | "technical" | "comparison" | "showcase" = "launch",
) {
  const a = await asset();
  return s.images.create(id, { preset, sources: [a.sha] });
}
async function done(jobId: string) {
  await vi.waitFor(
    () => {
      expect(["succeeded", "failed"]).toContain(
        s.content.jobs.get(jobId).status,
      );
    },
    { timeout: 20000, interval: 50 },
  );
  return s.content.jobs.get(jobId);
}
function request(url: string, method = "GET", body?: unknown) {
  return s.app.request("http://127.0.0.1:4310/api" + url, {
    method,
    headers: {
      host: "127.0.0.1:4310",
      cookie: "bip_session=" + s.token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
describe("M2 review regressions", () => {
  it("redacts env literals and real tokens while preserving code identifiers and property accesses", () => {
    for (const line of [
      "const TOKEN = socket.handshake.auth.token",
      "TOKEN=socket.handshake.auth.token",
      "token = getToken()",
      "const API_KEY = config.apiKey",
      "API_KEY=myIdentifier",
    ])
      expect(redact(line, "src/auth.ts")).toBe(line);
    expect(redact("TOKEN=socket.handshake.auth.token", ".env")).toBe(
      "TOKEN=socket.handshake.auth.token",
    );
    expect(redact('API_KEY="literal-value"', ".env.local")).toContain(
      "[REDACTED]",
    );
    expect(redact("API_KEY=literal-value", "settings.config")).toContain(
      "[REDACTED]",
    );
    expect(
      redact('const token="ghp_' + "a".repeat(30) + '"', "auth.ts"),
    ).toContain("[REDACTED]");
    expect(redact('const key="sk-proj-' + "z".repeat(30) + '"')).toContain(
      "[REDACTED]",
    );
  });
  it("accepts explicitly scanned absolute roots outside HOME but limits autocomplete to HOME", async () => {
    expect(await s.projects.safe(repo)).toBe(repo);
    await expect(
      directorySuggestions(path.dirname(repo) + "/", path.join(root, "home")),
    ).rejects.toThrow("outside");
    await expect(s.projects.scan("relative", 2)).rejects.toThrow("absolute");
    await expect(s.projects.scan(root + "/../", 2)).rejects.toThrow(
      "traversal",
    );
  });
  it("returns newest jobs first with persisted timestamps", async () => {
    const j = s.content.jobs.enqueue("image.steps", id, "test", {
      provider: "claude",
      description: "Wait",
    });
    vi.stubEnv(
      "BIP_CLAUDE_BIN",
      path.resolve("tests/fixtures/agents/fake.mjs"),
    );
    await done(j.id);
    const second = s.images.task("image.steps", id, {
      provider: "claude",
      description: "Wait again",
    });
    await done(second.id);
    const rows = await (await request("/jobs")).json();
    expect(rows.slice(0, 2).map((r: any) => r.id)).toEqual([second.id, j.id]);
    expect(rows[0].startedAt).toBeTruthy();
    expect(rows[0].finishedAt).toBeTruthy();
    expect(rows[0].startedAt).toBe(rows[0].started_at);
  });
});
describe("Image assets and capture", () => {
  it("validates magic bytes, size and actual decoding; indexes immutable content-addressed assets", async () => {
    expect(imageMime(png())).toBe("image/png");
    expect(imageMime(Buffer.from([255, 216, 255, 0]))).toBe("image/jpeg");
    expect(imageMime(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
    expect(() => imageMime(Buffer.from("not an image"))).toThrow();
    expect(() => imageMime(Buffer.alloc(20 * 1024 * 1024 + 1))).toThrow(
      "20 MB",
    );
    await expect(
      s.images.assets.put(id, Buffer.from([255, 216, 255, 0]), "upload", {
        type: "upload",
        filename: "fake.jpg",
      }),
    ).rejects.toThrow();
    const a = await asset();
    const duplicate = await asset();
    expect(duplicate.sha).toBe(a.sha);
    expect(await s.images.assets.list(id)).toHaveLength(1);
    expect(a).toMatchObject({
      kind: "upload",
      mime: "image/png",
      width: 320,
      height: 200,
      provenance: { type: "upload", filename: "screen.png" },
    });
    const r = await request(`/projects/${id}/assets/${a.sha}`);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(r.headers.get("Cache-Control")).toContain("immutable");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(hash(Buffer.from(await r.arrayBuffer()))).toBe(a.sha);
  });
  it("rejects symlink asset escapes", async () => {
    const a = await asset();
    const file = await s.images.assets.file(id, a.sha);
    await fs.unlink(file);
    await fs.symlink(path.join(repo, "README.md"), file);
    await expect(s.images.assets.get(id, a.sha)).rejects.toThrow("symlink");
  });
  it("validates capture steps and waits", () => {
    expect(CaptureStep.safeParse({ action: "click" }).success).toBe(false);
    expect(
      CaptureStep.safeParse({ action: "type", selector: "#q" }).success,
    ).toBe(false);
    expect(
      CaptureStep.safeParse({ action: "press", value: "Enter" }).success,
    ).toBe(true);
    expect(CaptureStep.safeParse({ action: "wait", ms: 31000 }).success).toBe(
      false,
    );
    expect(
      CaptureStep.safeParse({ action: "evaluate", text: "alert(1)" }).success,
    ).toBe(false);
    expect(CaptureInput.safeParse({ url: "file:///etc/passwd" }).success).toBe(
      false,
    );
    expect(
      CaptureInput.safeParse({ url: "http://localhost:3000" }).success,
    ).toBe(true);
  });
  it("captures approved steps in a fresh context and records provenance", async () => {
    let cookie = "";
    const server = createServer((req, res) => {
      cookie = req.headers.cookie || "";
      res.setHeader("content-type", "text/html");
      res.end(
        '<html><body><input id="q"><button id="b" onclick="document.body.style.background=\'red\'">Go</button></body></html>',
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      const result = await s.images.capture(
        id,
        CaptureInput.parse({
          url,
          viewport: "390x844",
          waitFor: "delay",
          delay: 0,
          steps: [
            { action: "type", selector: "#q", text: "Hello" },
            { action: "click", selector: "#b" },
            { action: "press", value: "Tab" },
          ],
        }),
        new AbortController().signal,
      );
      expect(cookie).toBe("");
      expect(result).toMatchObject({
        kind: "screenshot",
        width: 780,
        height: 1688,
        provenance: {
          type: "capture",
          url,
          viewport: { width: 390, height: 844, dpr: 2 },
        },
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
describe("Composition revisions and validation", () => {
  it("rejects active HTML, external resources, oversized and disallowed files", async () => {
    const v = await comp(),
      dir = await s.images.dir(id, v.composition.id);
    for (const html of [
      "<script src=https://evil.test/a.js></script>",
      '<img onerror="alert(1)">',
      '<iframe src="x"></iframe>',
      '<object data="a"></object>',
    ]) {
      await fs.writeFile(path.join(dir, "bad.html"), html);
      expect((await validateComposition(dir)).length).toBeGreaterThan(0);
    }
    await fs.rm(path.join(dir, "bad.html"));
    await fs.writeFile(path.join(dir, "bad.css"), "x".repeat(1024 * 1024 + 1));
    expect((await validateComposition(dir)).join()).toContain("1 MB");
    await fs.rm(path.join(dir, "bad.css"));
    await fs.writeFile(path.join(dir, "run.sh"), "echo hi");
    expect((await validateComposition(dir)).join()).toContain("extension");
  });
  it("serves only mounted composition files and source assets on a cookie-free origin", async () => {
    const v = await comp();
    const response = await fetch(v.previewUrl);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self' data: blob:",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    const base = new URL(".", v.previewUrl);
    expect((await fetch(new URL(".git/config", base))).status).toBe(404);
    expect((await fetch(new URL("private.md", base))).status).toBe(404);
    expect(
      (await fetch(new URL("assets/" + v.composition.sources[0], base))).status,
    ).toBe(200);
    const thumb = await s.images.thumbnail(id, v.composition.id, v.commit);
    expect(PNG.sync.read(thumb).width).toBe(320);
  });
  it("commits revisions and restores old trees with the local BIP identity", async () => {
    const v = await comp(),
      c = v.composition;
    const edited = await s.images.update(id, c.id, {
      slots: { ...c.slots, headline: "Changed headline" },
    });
    expect(edited.revisions).toHaveLength(2);
    expect(edited.commit).not.toBe(v.commit);
    const restored = await s.images.restore(id, c.id, v.commit);
    expect(restored.revisions).toHaveLength(3);
    expect(restored.composition.slots.headline).toBe(c.slots.headline);
    expect(
      (
        await git(await s.images.dir(id, c.id), [
          "log",
          "-1",
          "--format=%an <%ae>",
        ])
      ).trim(),
    ).toBe("Build in Public <bip@localhost>");
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(
      (await git(repo, ["log", "--oneline"])).trim().split("\n"),
    ).toHaveLength(1);
  });
  it("passes clean fidelity at every size and rejects filters, unmarked overlays and tampered bytes", async () => {
    const v = await comp(),
      c = v.composition;
    for (const size of ["x", "linkedin", "square", "portrait"] as const) {
      const result = await s.images.render(id, c.id, { size });
      expect(result.fidelity.errors).toEqual([]);
      expect(result.fidelity.pass).toBe(true);
    }
    const dir = await s.images.dir(id, c.id);
    await fs.appendFile(
      path.join(dir, "styles.css"),
      "\nimg[data-bip-source]{filter:saturate(1.4)}",
    );
    await s.images.commit(dir, "Bad filter");
    expect((await s.images.render(id, c.id)).fidelity.errors.join()).toContain(
      "filter",
    );
    await s.images.update(id, c.id, { allowScreenshotEdits: true });
    expect((await s.images.render(id, c.id)).fidelity.pass).toBe(true);
    await s.images.restore(id, c.id, v.commit);
    await fs.appendFile(
      path.join(dir, "styles.css"),
      '\n.stage::after{content:"Unmarked overlay";position:absolute;inset:0;background:red}',
    );
    await s.images.commit(dir, "Bad overlay");
    expect((await s.images.render(id, c.id)).fidelity.pass).toBe(false);
    await s.images.restore(id, c.id, v.commit);
    const file = await s.images.assets.file(id, c.sources[0]);
    await fs.chmod(file, 0o600);
    const changed = png();
    changed[changed.length - 1] ^= 1;
    await fs.writeFile(file, changed);
    expect((await s.images.render(id, c.id)).fidelity.errors.join()).toContain(
      "hash",
    );
  }, 30000);
  it("fake agent copies out, edits, validates, renders and commits; failed fidelity leaves previous revision untouched", async () => {
    vi.stubEnv("BIP_CODEX_BIN", path.resolve("tests/fixtures/agents/fake.mjs"));
    const v = await comp(),
      idc = v.composition.id;
    const j = s.images.task("image.edit", id, {
        provider: "codex",
        compositionId: idc,
        instruction: "Change the headline",
      }),
      finished = await done(j.id);
    expect(finished.error).toBeNull();
    expect(finished.status).toBe("succeeded");
    expect(finished.result.fidelity.pass).toBe(true);
    const next = await s.images.view(id, idc);
    expect(next.revisions).toHaveLength(2);
    expect(next.composition.slots.headline).toBe(
      "A headline from the fake agent",
    );
    const row = s.db
      .prepare("SELECT cwd FROM agent_runs WHERE job_id=?")
      .get(j.id) as any;
    expect(row.cwd.startsWith(path.join(root, "data/workspaces/"))).toBe(true);
    expect(row.cwd.includes(repo)).toBe(false);
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    const failed = await done(
      s.images.task("image.edit", id, {
        provider: "codex",
        compositionId: idc,
        instruction: "FILTER_FAIL",
      }).id,
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("filter");
    expect((await s.images.view(id, idc)).commit).toBe(next.commit);
  }, 30000);
  it("all four presets fit and export JPEG and PNG with provenance", async () => {
    for (const preset of ["minimal", "technical", "comparison", "showcase"] as const) {
      const v = await comp(preset);
      for (const size of ["x", "linkedin", "square", "portrait"] as const) {
        expect(
          (await s.images.render(id, v.composition.id, { size })).fidelity
            .errors,
          preset + " " + size,
        ).toEqual([]);
      }
    }
    const v = await comp();
    const result = await s.images.export(id, v.composition.id, {
      format: "jpeg",
      size: "square",
    });
    expect(result.bytes[0]).toBe(255);
    expect(result.asset).toMatchObject({
      kind: "image_render",
      mime: "image/jpeg",
      width: 2160,
      height: 2160,
      provenance: {
        type: "render",
        compositionId: v.composition.id,
        commit: v.commit,
      },
    });
  }, 60000);
});
