import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { info, log, git, discover, countSince, validateRepo } from "./git.js";
import { mapLimit } from "./projects.js";
import type { DiscoveredRepo, ProjectRow } from "@bip/shared";
import { resolveSafe, directorySuggestions } from "./paths.js";
import { openDatabase } from "./db.js";
import { openProject } from "./bip/store.js";
import { createApp } from "./app.js";
import { backup } from "./backup.js";
const exec = promisify(execFile);
let root: string;
const close: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-unit-"));
});
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  await fs.rm(root, { recursive: true, force: true });
});
async function repo(name = "repo") {
  const p = path.join(root, name);
  await fs.mkdir(p, { recursive: true });
  await git(p, ["init", "-b", "main"]);
  await git(p, ["config", "user.name", "Test Author"]);
  await git(p, ["config", "user.email", "test@example.com"]);
  return p;
}
async function commit(
  p: string,
  subject = "First commit",
  date = "2026-11-01T12:00:00Z",
) {
  await fs.writeFile(path.join(p, "file.txt"), subject);
  await git(p, ["add", "."]);
  await exec("git", ["commit", "-m", subject], {
    cwd: p,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return (await info(p)).head;
}
function service() {
  const s = createApp({
    home: path.join(root, "app"),
    fsHome: root,
    token: "a".repeat(64),
  });
  close.push(() => s.close());
  return s;
}
function request(
  s: ReturnType<typeof createApp>,
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return s.app.request(`http://127.0.0.1:4310${url}`, {
    method,
    headers: {
      host: "127.0.0.1:4310",
      cookie: `bip_session=${s.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
describe("Git service", () => {
  it("parses subject, body, author, dates and numstat", async () => {
    const p = await repo();
    await commit(p, "First commit\n\nDetails here");
    const entries = await log(p, { limit: 50, offset: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subject: "First commit",
      body: "Details here\n",
      authorName: "Test Author",
      authorEmail: "test@example.com",
      insertions: 3,
      deletions: 0,
    });
    expect(entries[0].files[0].path).toBe("file.txt");
    expect(entries[0].date).toContain("2026-11-01");
  });
  it("handles empty repositories", async () => {
    const p = await repo();
    expect(await info(p)).toMatchObject({
      branch: "main",
      head: "",
      rootCommit: "",
      lastCommitAt: null,
    });
    expect(await log(p, { limit: 50, offset: 0 })).toEqual([]);
    expect(await countSince(p)).toEqual({ count: 0, markerLost: false });
  });
  it("reports detached HEAD", async () => {
    const p = await repo();
    const sha = await commit(p);
    await git(p, ["checkout", "--detach"]);
    expect((await info(p)).branch).toBe(`detached at ${sha.slice(0, 7)}`);
  });
  it("treats binary numstat as zero", async () => {
    const p = await repo();
    await fs.writeFile(
      path.join(p, "binary.dat"),
      Buffer.from([0, 2, 3, 0, 5]),
    );
    await commit(p);
    const [entry] = await log(p, { limit: 50, offset: 0 });
    expect(entry.files.find((f) => f.path === "binary.dat")).toEqual({
      path: "binary.dat",
      insertions: 0,
      deletions: 0,
    });
  });
  it("parses merge commits and pages without losing records", async () => {
    const p = await repo();
    await commit(p);
    await git(p, ["checkout", "-b", "side"]);
    await fs.writeFile(path.join(p, "side"), "side");
    await git(p, ["add", "."]);
    await git(p, ["commit", "-m", "Side"]);
    await git(p, ["checkout", "main"]);
    await fs.writeFile(path.join(p, "main"), "main");
    await git(p, ["add", "."]);
    await git(p, ["commit", "-m", "Main"]);
    await git(p, ["merge", "--no-ff", "side", "-m", "Merge side"]);
    const rows = await log(p, { limit: 50, offset: 0 });
    expect(rows).toHaveLength(4);
    expect(rows[0].subject).toBe("Merge side");
    expect((await log(p, { limit: 1, offset: 1 }))[0].sha).toBe(rows[1].sha);
  });
  it("counts all commits and commits after a marker", async () => {
    const p = await repo();
    const first = await commit(p);
    await commit(p, "Second", "2026-11-02T12:00:00Z");
    await commit(p, "Third", "2026-11-03T12:00:00Z");
    expect(await countSince(p)).toEqual({ count: 3, markerLost: false });
    expect(await countSince(p, first)).toEqual({ count: 2, markerLost: false });
  });
  it("falls back to saved date for a rebased-away and pruned marker", async () => {
    const p = await repo();
    await commit(p);
    const sha = await commit(p, "Old second", "2026-11-02T12:00:00Z");
    await git(p, ["reset", "--hard", "HEAD~1"]);
    await commit(p, "Replacement", "2026-11-03T12:00:00Z");
    await git(p, ["reflog", "expire", "--expire=now", "--all"]);
    await git(p, ["gc", "--prune=now"]);
    expect(await countSince(p, sha, "2026-11-02T12:00:00Z")).toEqual({
      count: 1,
      markerLost: true,
    });
  });
  it("flags a marker no longer in HEAD ancestry even when its object survives", async () => {
    const p = await repo();
    await commit(p);
    const sha = await commit(p, "Removed", "2026-11-02T12:00:00Z");
    await git(p, ["reset", "--hard", "HEAD~1"]);
    await commit(p, "Replacement", "2026-11-03T12:00:00Z");
    expect(await countSince(p, sha)).toEqual({ count: 1, markerLost: true });
  });
});
describe("Discovery and safe paths", () => {
  it("honors depth, skip rules and stops at a found repository", async () => {
    const a = await repo("a");
    await repo("a/nested");
    await repo("group/b");
    for (const name of [
      "node_modules",
      "venv",
      "dist",
      "build",
      "target",
      ".cache",
      ".hidden",
      ".venv",
      ".next",
    ])
      await repo(`${name}/skip`);
    expect(await discover(root, 1)).toEqual([a]);
    expect(await discover(root, 2)).toEqual([a, path.join(root, "group/b")]);
  });
  it("finds a worktree with a .git file", async () => {
    const p = await repo();
    await commit(p);
    await git(p, [
      "worktree",
      "add",
      path.join(root, "worktree"),
      "-b",
      "worktree",
    ]);
    expect(await discover(root)).toContain(path.join(root, "worktree"));
  });
  it("rejects traversal and symlink escapes", async () => {
    await fs.mkdir(path.join(root, "allowed"));
    await fs.symlink(os.tmpdir(), path.join(root, "allowed", "escape"));
    await expect(
      resolveSafe(path.join(root, "allowed", "../allowed"), [
        path.join(root, "allowed"),
      ]),
    ).resolves.toBe(path.join(root, "allowed"));
    await expect(
      resolveSafe(root + "/allowed/../allowed", [root]),
    ).rejects.toThrow("traversal");
    await expect(
      resolveSafe(path.join(root, "allowed", "escape"), [
        path.join(root, "allowed"),
      ]),
    ).rejects.toThrow("outside");
  });
  it("autocomplete limits itself to home and hides dotfolders unless typed", async () => {
    await fs.mkdir(path.join(root, ".secret"));
    await fs.mkdir(path.join(root, "visible"));
    await fs.symlink(os.tmpdir(), path.join(root, "escape"));
    expect(await directorySuggestions(root + "/", root)).toEqual([
      path.join(root, "visible"),
    ]);
    expect(await directorySuggestions(root + "/.s", root)).toEqual([
      path.join(root, ".secret"),
    ]);
    await expect(directorySuggestions("/etc/", root)).rejects.toThrow(
      "outside",
    );
  });
});
describe("Security middleware", () => {
  it("requires the session cookie on every API route", async () => {
    const s = service();
    const r = await s.app.request("http://127.0.0.1:4310/api/health", {
      headers: { host: "127.0.0.1:4310" },
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toHaveProperty("error.code", "UNAUTHORIZED");
  });
  it("rejects a bad Host", async () => {
    const s = service();
    expect(
      (
        await request(s, "/api/health", "GET", undefined, {
          host: "evil.example:4310",
        })
      ).status,
    ).toBe(403);
  });
  it("rejects a bad Origin for mutations", async () => {
    const s = service();
    expect(
      (
        await request(
          s,
          "/api/scan",
          "POST",
          { root, depth: 2 },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
  });
  it("exchanges a token for a strict HttpOnly cookie and redirects", async () => {
    const s = service();
    const r = await request(s, `/?token=${s.token}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    expect(r.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(r.headers.get("location")).toBe("/");
    expect((await request(s, "/?token=invalid")).status).toBe(401);
  });
  it("does not permit a production no-auth override", async () => {
    const s = createApp({
      home: path.join(root, "app"),
      fsHome: root,
      dev: false,
      noAuth: true,
    });
    close.push(() => s.close());
    expect(
      (await s.app.request("http://127.0.0.1:4310/api/health")).status,
    ).toBe(401);
  });
  it("accepts the Vite origin and dev-only no-auth override", async () => {
    const s = createApp({
      home: path.join(root, "app"),
      fsHome: root,
      dev: true,
      noAuth: true,
    });
    close.push(() => s.close());
    expect(
      (
        await s.app.request("http://127.0.0.1:4310/api/projects", {
          headers: { origin: "http://127.0.0.1:5173" },
        })
      ).status,
    ).toBe(200);
  });
  it("validates request bodies", async () => {
    const s = service();
    expect(
      (await request(s, "/api/scan", "POST", { root, depth: 99 })).status,
    ).toBe(400);
    expect(
      (await request(s, "/api/projects", "POST", { paths: [] })).status,
    ).toBe(400);
  });
});
describe("Store, registry and migrations", () => {
  it("tracks cleanly and initializes metadata with a null marker", async () => {
    const p = await repo();
    await commit(p);
    const s = service();
    const r = await request(s, "/api/projects", "POST", { paths: [p] });
    expect(r.status).toBe(200);
    const data = JSON.parse(
      await fs.readFile(path.join(p, ".bip/project.json"), "utf8"),
    );
    expect(data.lastSharedCommit).toBeNull();
    expect(await git(p, ["status", "--porcelain"])).toBe("");
  });
  it("supports context round trip, opt-in and opt-out", async () => {
    const p = await repo();
    await commit(p);
    const s = await openProject(p);
    close.push(() => s.close());
    await s.writeContext({ shareable: "Public notes", private: "Never share" });
    expect(await s.readContext()).toEqual({
      shareable: "Public notes",
      private: "Never share",
    });
    await s.optInCommitContext();
    expect(
      (await git(p, ["status", "--porcelain", "--untracked-files=all"]))
        .trim()
        .split("\n")
        .map((l) => l.trim()),
    ).toEqual(["?? .bip/.gitignore", "?? .bip/context.md"]);
    await s.optOut();
    expect(await git(p, ["status", "--porcelain"])).toBe("");
  });
  it("uses read-only handles while a live writer holds its lock", async () => {
    const p = await repo();
    const a = await openProject(p);
    close.push(() => a.close());
    const b = await openProject(p);
    close.push(() => b.close());
    expect(b.readOnly).toBe(true);
    await expect(
      b.writeContext({ shareable: "bad", private: "bad" }),
    ).rejects.toThrow("read-only");
  });
  it("rejects symlinks inside the store", async () => {
    const p = await repo();
    const s = await openProject(p);
    close.push(() => s.close());
    await fs.unlink(path.join(p, ".bip/private.md"));
    await fs.symlink(
      path.join(root, "outside"),
      path.join(p, ".bip/private.md"),
    );
    await expect(
      s.writeContext({ shareable: "ok", private: "bad" }),
    ).rejects.toThrow("Symlink");
  });
  it("relinks a moved repository on rescan with its notes intact", async () => {
    const p = await repo();
    await commit(p);
    const s = service();
    await s.projects.track([p]);
    const [before] = await s.projects.list();
    await (
      await s.projects.store(before.id)
    ).writeContext({ shareable: "travels with repo", private: "secret" });
    const moved = path.join(root, "renamed");
    await fs.rename(p, moved);
    await s.projects.refreshMissing();
    expect((await s.projects.list())[0].status).toBe("missing");
    await s.projects.scan(root, 2);
    const [after] = await s.projects.list();
    expect(after.id).toBe(before.id);
    expect(after.path).toBe(moved);
    expect(after.readOnly).toBe(false);
    await (
      await s.projects.store(after.id)
    ).writeContext({
      shareable: "travels with repo",
      private: "still writable",
    });
    expect(
      (await (await s.projects.store(after.id)).readContext()).shareable,
    ).toBe("travels with repo");
  });
  it("persists registry and context across restart", async () => {
    const p = await repo();
    const home = path.join(root, "app");
    let s = createApp({ home, fsHome: root });
    await s.projects.track([p]);
    const [first] = await s.projects.list();
    await (
      await s.projects.store(first.id)
    ).writeContext({ shareable: "persisted", private: "private" });
    await s.close();
    s = createApp({ home, fsHome: root });
    close.push(() => s.close());
    expect((await s.projects.list())[0].id).toBe(first.id);
    expect(
      (await (await s.projects.store(first.id)).readContext()).shareable,
    ).toBe("persisted");
  });
  it("migrations are idempotent and back up before an upgrade", async () => {
    const home = path.join(root, "db");
    const first = openDatabase(home);
    first
      .prepare("INSERT INTO tracked_dirs(id,path,depth) VALUES(?,?,?)")
      .run(randomUUID(), root, 2);
    expect(first.pragma("user_version", { simple: true })).toBe(2);
    first.close();
    const second = openDatabase(home);
    expect(second.prepare("SELECT * FROM tracked_dirs").all()).toHaveLength(1);
    expect(second.pragma("foreign_keys", { simple: true })).toBe(1);
    second.close();
    await fs.mkdir(path.join(root, "upgrade"));
    const old = await import("better-sqlite3");
    const legacy = new old.default(path.join(root, "upgrade/app.db"));
    legacy.close();
    const upgraded = openDatabase(path.join(root, "upgrade"));
    expect(upgraded.pragma("user_version", { simple: true })).toBe(2);
    upgraded.close();
    expect(
      (await fs.readdir(path.join(root, "upgrade"))).some((f) =>
        f.includes(".backup-"),
      ),
    ).toBe(true);
  });
  it("backup archives context and excludes renders", async () => {
    const p = await repo();
    const s = await openProject(p);
    close.push(() => s.close());
    await fs.mkdir(path.join(s.root, "renders"));
    await fs.writeFile(
      path.join(s.root, "renders", "big.mp4"),
      "not real video",
    );
    const { file } = await backup(path.join(root, "app"), s.project.id, p);
    const contents = (await exec("tar", ["-tzf", file])).stdout;
    expect(contents).toContain(".bip/context.md");
    expect(contents).not.toContain("renders");
    expect(contents).not.toContain(".lock");
  });
  it("marks a middle commit shared and updates the list count", async () => {
    const p = await repo();
    await commit(p);
    const mid = await commit(p, "Second", "2026-11-02T12:00:00Z");
    await commit(p, "Third", "2026-11-03T12:00:00Z");
    const s = service();
    await s.projects.track([p]);
    const [r] = await s.projects.list();
    expect(r.unsharedCount).toBe(3);
    expect(
      (
        await request(s, `/api/projects/${r.id}/mark-shared`, "POST", {
          sha: mid,
        })
      ).status,
    ).toBe(200);
    expect((await s.projects.list())[0].unsharedCount).toBe(1);
  });
  it("concurrent opens reuse the writer handle after restart", async () => {
    const p = await repo();
    const home = path.join(root, "data");
    const first = createApp({ home, fsHome: root });
    await first.projects.track([p]);
    const [row] = await first.projects.list();
    await first.close();
    const second = createApp({ home, fsHome: root });
    close.push(() => second.close());
    const [a, b] = await Promise.all([
      second.projects.store(row.id),
      second.projects.store(row.id),
    ]);
    expect(a).toBe(b);
    expect(a.readOnly).toBe(false);
  });
  it("relinks by root commit and remote when metadata is absent", async () => {
    const p = await repo();
    await commit(p);
    await git(p, ["remote", "add", "origin", "https://example.test/repo.git"]);
    const s = service();
    await s.projects.track([p]);
    const [row] = await s.projects.list();
    await s.projects.close();
    await fs.rm(path.join(p, ".bip"), { recursive: true });
    const moved = path.join(root, "moved");
    await fs.rename(p, moved);
    await s.projects.scan(root, 2);
    const [after] = await s.projects.list();
    expect(after.id).toBe(row.id);
    expect(after.path).toBe(moved);
    expect(after.readOnly).toBe(false);
  });
  it("manual locate rejects unrelated repositories and accepts a moved identity", async () => {
    const p = await repo();
    await commit(p);
    const other = await repo("other");
    await commit(other, "Unrelated");
    const s = service();
    await s.projects.track([p]);
    const [row] = await s.projects.list();
    await expect(s.projects.locate(row.id, other)).rejects.toThrow(
      "does not match",
    );
    const moved = path.join(root, "located");
    await fs.rename(p, moved);
    expect((await s.projects.locate(row.id, moved)).path).toBe(moved);
    expect((await s.projects.row(row.id)).readOnly).toBe(false);
  });
  it("untracking keeps data and confirmed deletion removes it", async () => {
    const p = await repo();
    const s = service();
    await s.projects.track([p]);
    const [r] = await s.projects.list();
    await expect(s.projects.deleteData(r.id, "wrong")).rejects.toThrow(
      "confirm",
    );
    await s.projects.untrack(r.id);
    expect(await fs.stat(path.join(p, ".bip"))).toBeTruthy();
    await s.projects.track([p]);
    await s.projects.deleteData(r.id, r.name);
    await expect(fs.stat(path.join(p, ".bip"))).rejects.toThrow();
    expect(await s.projects.list()).toEqual([]);
  });
});
describe("Invalid repositories (M5 §0.9)", () => {
  async function brokenRepo(withSibling: boolean) {
    const p = path.join(root, "projects", "broken");
    await fs.mkdir(path.join(p, ".git"), { recursive: true });
    if (withSibling) {
      // A real git dir living next to an empty .git, as seen on a user machine.
      const src = await repo("source");
      await commit(src);
      await fs.cp(path.join(src, ".git"), path.join(p, ".git-local"), {
        recursive: true,
      });
      await fs.rm(src, { recursive: true });
    }
    return p;
  }
  it("discovery lists an empty .git as invalid, with a fix hint for a sibling git dir", async () => {
    const plain = await brokenRepo(false);
    expect(await validateRepo(plain)).toEqual({
      valid: false,
      reason: "Not a valid Git repository (.git is empty or broken)",
    });
    await fs.rm(plain, { recursive: true });
    const p = await brokenRepo(true);
    const good = await repo("projects/good");
    await commit(good);
    const s = service();
    const r = await request(s, "/api/scan", "POST", {
      root: path.join(root, "projects"),
      depth: 2,
    });
    const found = (await r.json()) as DiscoveredRepo[];
    const bad = found.find((f) => f.path === p)!;
    expect(bad).toMatchObject({ invalid: true, head: "", tracked: false });
    expect(bad.reason).toContain(".git-local");
    expect(bad.fix).toBe("rmdir .git && printf 'gitdir: .git-local\\n' > .git");
    expect(found.find((f) => f.path === good)?.invalid).toBeUndefined();
    // The suggested gitfile is a standard repair: applying it makes the repo valid.
    await fs.rmdir(path.join(p, ".git"));
    await fs.writeFile(path.join(p, ".git"), "gitdir: .git-local\n");
    expect(await validateRepo(p)).toEqual({ valid: true });
  });
  it("does not treat a folder inside another repository as valid", async () => {
    const outer = await repo("outer");
    await commit(outer);
    const inner = path.join(outer, "inner");
    await fs.mkdir(path.join(inner, ".git"), { recursive: true });
    expect((await validateRepo(inner)).valid).toBe(false);
  });
  it("refuses to track an invalid repository without writing anything", async () => {
    const p = await brokenRepo(true);
    const s = service();
    const r = await request(s, "/api/projects", "POST", { paths: [p] });
    expect(r.status).toBe(400);
    const body = (await r.json()) as {
      error: { code: string; message: string; hint?: string };
    };
    expect(body.error.code).toBe("INVALID_REPO");
    expect(body.error.message).not.toContain("Command failed");
    expect(body.error.hint).toContain("gitdir: .git-local");
    await expect(fs.stat(path.join(p, ".bip"))).rejects.toThrow();
    expect(await fs.readdir(path.join(p, ".git"))).toEqual([]);
    expect(
      await fs
        .readFile(path.join(p, ".git-local/info/exclude"), "utf8")
        .catch(() => ""),
    ).not.toContain(".bip");
    expect(s.projects.registry()).toEqual([]);
  });
  it("keeps tracking unborn repositories and .git files (worktrees)", async () => {
    const empty = await repo("empty");
    expect(await validateRepo(empty)).toEqual({ valid: true });
    const main = await repo("main");
    await commit(main);
    const wt = path.join(root, "wt");
    await git(main, ["worktree", "add", "-b", "feature", wt]);
    expect((await fs.lstat(path.join(wt, ".git"))).isFile()).toBe(true);
    const s = service();
    const rows = await s.projects.track([empty, wt]);
    expect(rows.map((r) => r.path).sort()).toEqual([empty, wt].sort());
    expect(rows.find((r) => r.path === empty)).toMatchObject({
      head: "",
      unsharedCount: 0,
    });
  });
});
describe("Projects list cache (M5 §0.3)", () => {
  it("serves cached rows first, then revalidates in the background", async () => {
    const p = await repo();
    await commit(p);
    const s = service();
    await s.projects.track([p]);
    const first = await request(s, "/api/projects?cached=1");
    expect(first.headers.get("X-BIP-Stale")).toBe("1");
    expect(((await first.json()) as ProjectRow[])[0].unsharedCount).toBe(1);
    await commit(p, "Second commit", "2026-11-02T12:00:00Z");
    // Stale response: the old count comes back immediately, a refresh starts.
    const stale = await s.projects.cachedList();
    expect(stale.stale).toBe(true);
    expect(stale.rows[0].unsharedCount).toBe(1);
    await s.projects.refresh();
    expect((await s.projects.cachedList()).rows[0].unsharedCount).toBe(2);
    // The plain list is always fresh.
    await commit(p, "Third commit", "2026-11-03T12:00:00Z");
    expect((await s.projects.list())[0].unsharedCount).toBe(3);
  });
  it("computes fresh rows when nothing is cached yet", async () => {
    const p = await repo();
    await commit(p);
    const s = service();
    await s.projects.track([p]);
    const s2 = createApp({
      home: path.join(root, "app"),
      fsHome: root,
      token: "b".repeat(64),
    });
    await s.close();
    close.push(() => s2.close());
    const r = await s2.projects.cachedList();
    expect(r.stale).toBe(false);
    expect(r.rows[0].unsharedCount).toBe(1);
  });
  it("mapLimit preserves order and bounds concurrency", async () => {
    let active = 0,
      peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, n * 3));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 8, 4, 6, 0, 12]);
    expect(peak).toBe(3);
  });
});
