import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import type { AgentStatus, Check, DoctorReport } from "@bip/shared";
import { browserPath, hyperframes } from "./video/process.js";
import { binaryFor } from "./config.js";
const exec = promisify(execFile);
export async function agents(): Promise<AgentStatus[]> {
  return Promise.all(
    ["claude", "codex"].map(async (id) => {
      try {
        const version = (
          await exec(binaryFor(id as "claude" | "codex"), ["--version"], {
            timeout: 10000,
          })
        ).stdout.trim();
        let auth: AgentStatus["auth"] = "unknown";
        if (id === "codex") {
          auth = await exec(
            binaryFor(id as "claude" | "codex"),
            ["login", "status"],
            { timeout: 10000 },
          )
            .then(() => "signed in" as const)
            .catch(() => "not signed in" as const);
        }
        return {
          id,
          installed: true,
          usable: auth !== "not signed in",
          version,
          auth,
          hint:
            auth === "signed in"
              ? ""
              : id === "claude"
                ? "Run claude once in a terminal to sign in"
                : "Run codex login to sign in",
        };
      } catch {
        return {
          id,
          installed: false,
          usable: false,
          auth: "unknown",
          hint: `Install ${id}, then sign in in a terminal`,
        };
      }
    }),
  );
}
export async function doctor(
  home: string,
  port: number,
  running = false,
  repos: string[] = [],
): Promise<DoctorReport> {
  const checks: Check[] = [
    {
      name: `Node ${process.versions.node}`,
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      hard: true,
      hint: "Install Node 22 or later",
    },
  ];
  for (const [binary, args, hint] of [
    ["git", ["--version"], "Install Git"],
    ["ffmpeg", ["-version"], "Install FFmpeg"],
    ["ffprobe", ["-version"], "Install FFmpeg including ffprobe"],
  ] as const) {
    const ok = await exec(binary, [...args], { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    checks.push({ name: binary, ok, hard: true, hint });
  }
  checks.push({
    name: "Playwright Chromium",
    ok: await fs
      .access(chromium.executablePath())
      .then(() => true)
      .catch(() => false),
    hard: true,
    hint: "Run pnpm exec playwright install chromium",
  });
  checks.push({
    name: "HyperFrames 0.9.13",
    ok: await hyperframes(["--version"], home, home)
      .then((s) => s.includes("0.9.13"))
      .catch(() => false),
    hard: true,
    hint: "Run pnpm install",
  });
  checks.push({
    name: "HyperFrames Chromium",
    ok: await fs
      .access(browserPath())
      .then(() => true)
      .catch(() => false),
    hard: true,
    hint: "Set chromiumPath in BIP config or install Playwright Chromium",
  });
  for (const a of await agents())
    checks.push({
      name: `${a.id}${a.version ? ": " + a.version : ""} (${a.auth})`,
      ok: a.installed && a.auth !== "not signed in",
      hard: false,
      hint: a.hint,
    });
  const writable = await fs
    .mkdir(home, { recursive: true })
    .then(async () => {
      const p = path.join(home, `.doctor-${process.pid}`);
      await fs.writeFile(p, "ok", { flag: "wx" });
      await fs.unlink(p);
      return true;
    })
    .catch(() => false);
  checks.push({
    name: "App data writable",
    ok: writable,
    hard: true,
    hint: "Set BIP_HOME to a writable folder",
  });
  const free =
    running ||
    (await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    }));
  checks.push({
    name: running ? `Port ${port} (this server)` : `Port ${port} free`,
    ok: free,
    hard: true,
    hint: "Stop the other process or set BIP_PORT",
  });
  for (const repo of repos) {
    if (
      await fs
        .access(path.join(repo, "Dockerfile"))
        .then(() => true)
        .catch(() => false)
    ) {
      const ignore = await fs
        .readFile(path.join(repo, ".dockerignore"), "utf8")
        .catch(() => "");
      checks.push({
        name: `Docker context: ${repo}`,
        ok: ignore.split("\n").some((l) => /^\/?\.bip\/?$/.test(l.trim())),
        hard: false,
        hint: "Add .bip/ to .dockerignore to keep private notes out of Docker builds",
      });
    }
  }
  const backups: string[] = [];
  for (const id of await fs
    .readdir(path.join(home, "backups"))
    .catch(() => [])) {
    for (const f of await fs.readdir(path.join(home, "backups", id)))
      backups.push(path.join(home, "backups", id, f));
  }
  return { checks, dataPath: home, backups: backups.sort().reverse() };
}
