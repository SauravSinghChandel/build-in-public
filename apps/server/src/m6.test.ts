import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixFor, minimumMet, osFamily, type SetupItem } from "./setup.js";
import { versions } from "./doctor.js";
import { openDatabase } from "./db.js";
import { JobRunner } from "./jobs/runner.js";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");

describe("setup", () => {
  it("detects OS families from os-release", () => {
    expect(osFamily("darwin", "")).toBe("macos");
    expect(osFamily("linux", 'ID=ubuntu\nID_LIKE="debian"')).toBe("debian");
    expect(osFamily("linux", "ID=fedora")).toBe("fedora");
    expect(osFamily("linux", "ID=manjaro\nID_LIKE=arch")).toBe("arch");
    expect(osFamily("linux", "ID=alpine")).toBe("other");
  });
  it("gives per-family fixes and lists all families when unknown", () => {
    expect(fixFor("ffmpeg", "fedora")).toEqual(["sudo dnf install -y ffmpeg-free"]);
    expect(fixFor("git", "macos")).toEqual(["brew install git"]);
    expect(fixFor("ffmpeg", "other")).toHaveLength(4);
    expect(fixFor("codex", "arch")[0]).toContain("codex login");
  });
  it("needs Node, git, ffmpeg, Chromium and one agent", () => {
    const base: SetupItem[] = [
      { key: "node", name: "", ok: true, required: true },
      { key: "git", name: "", ok: true, required: true },
      { key: "ffmpeg", name: "", ok: true, required: true },
      { key: "chromium", name: "", ok: true, required: true },
      { key: "hyperframes", name: "", ok: false, required: false },
      { key: "claude", name: "", ok: false, required: false },
      { key: "codex", name: "", ok: true, required: false },
    ];
    expect(minimumMet(base)).toBe(true);
    expect(minimumMet(base.map((i) => (i.key === "codex" ? { ...i, ok: false } : i)))).toBe(false);
    expect(minimumMet(base.map((i) => (i.key === "git" ? { ...i, ok: false } : i)))).toBe(false);
  });
  it("reports BIP and tool versions", async () => {
    const v = await versions([]);
    expect(v.bip).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.hyperframes).toBe("0.9.13");
    expect(v.playwright).toMatch(/^1\./);
  });
});

describe("licence guard", () => {
  it("passes on the real lockfile and fails on gsap or remotion", async () => {
    await exec(process.execPath, [path.join(root, "scripts/licence-guard.mjs")]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bip-guard-"));
    for (const line of ["  gsap@3.12.5:", "  '@remotion/player@4.0.0':", "      remotion: 4.0.0"]) {
      const file = path.join(dir, "pnpm-lock.yaml");
      await fs.writeFile(file, `packages:\n  zod@4.0.0:\n${line}\n`);
      await expect(
        exec(process.execPath, [path.join(root, "scripts/licence-guard.mjs"), file]),
      ).rejects.toMatchObject({ code: 1 });
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("demo project", () => {
  it("creates a 12-commit repo across 4 days with a static server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bip-demo-test-"));
    try {
      const { stdout } = await exec(process.execPath, [
        path.join(root, "examples/demo-project/create.mjs"),
        dir,
      ]);
      const repo = path.join(dir, "shiplog");
      expect(stdout).toContain(`node ${path.join(repo, "serve.mjs")}`);
      const log = (
        await exec("git", ["log", "--format=%ad", "--date=short"], { cwd: repo })
      ).stdout.trim().split("\n");
      expect(log).toHaveLength(12);
      expect(new Set(log).size).toBe(4);
      expect((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe("");
      const html = await fs.readFile(path.join(repo, "index.html"), "utf8");
      expect(html).toContain('id="go"');
      await expect(
        exec(process.execPath, [path.join(root, "examples/demo-project/create.mjs"), dir]),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("agent workspace cleanup", () => {
  it("deletes on success/cancel, keeps failures 7 days, prunes on start", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "bip-ws-"));
    const workspaces = path.join(home, "workspaces");
    const db = openDatabase(home);
    db.prepare(
      "INSERT INTO projects(id,path,root_commit,added_at) VALUES('p','/test','sha','now')",
    ).run();
    const exists = (id: string) =>
      fs.access(path.join(workspaces, id)).then(() => true, () => false);
    const until = async (fn: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 200 && !(await fn()); i++)
        await new Promise((r) => setImmediate(r));
      expect(await fn()).toBe(true);
    };
    const runner = new JobRunner(
      db,
      async (job, signal) => {
        await fs.mkdir(path.join(workspaces, job.id), { recursive: true });
        if (job.payload.mode === "fail") throw Error("boom");
        if (job.payload.mode === "hang")
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(Error("Cancelled"))),
          );
        return null;
      },
      workspaces,
    );
    try {
      await runner.start();
      const ok = runner.enqueue("t", "p", "a", { mode: "ok" });
      const failed = runner.enqueue("t", "p", "b", { mode: "fail" });
      await until(async () => runner.get(ok.id).status === "succeeded" && !(await exists(ok.id)));
      await until(() => runner.get(failed.id).status === "failed");
      expect(await exists(failed.id)).toBe(true);
      const hang = runner.enqueue("t", "p", "c", { mode: "hang" });
      await until(() => exists(hang.id));
      runner.cancel(hang.id);
      await until(async () => runner.get(hang.id).status === "cancelled" && !(await exists(hang.id)));
      // Orphans go at once; failures only once they're a week old.
      await fs.mkdir(path.join(workspaces, "orphan"), { recursive: true });
      expect(await runner.prune()).toEqual(["orphan"]);
      expect(await exists(failed.id)).toBe(true);
      expect(await runner.prune(Date.now() + JobRunner.KEEP_FAILED_MS + 1000)).toEqual([failed.id]);
      expect(await exists(failed.id)).toBe(false);
    } finally {
      await runner.close();
      db.close();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
