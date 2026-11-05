import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  Project,
  type ProjectRow,
  type TrackedDir,
  type DiscoveredRepo,
} from "@bip/shared";
import { openProject } from "./bip/store.js";
import {
  info,
  discover,
  countSince,
  git as runGit,
  validateRepo,
} from "./git.js";
import { resolveSafe, folderSize } from "./paths.js";
async function readMetadata(repo: string) {
  try {
    const file = await resolveSafe(path.join(repo, ".bip/project.json"), [
      repo,
    ]);
    return Project.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
const GIT_CONCURRENCY = 6;
const byUnshared = (a: ProjectRow, b: ProjectRow) =>
  b.unsharedCount - a.unsharedCount || a.name.localeCompare(b.name);
async function assertRepo(p: string) {
  const check = await validateRepo(p);
  if (!check.valid)
    throw Object.assign(
      Error(`Couldn't track ${path.basename(p)}: ${check.reason}`),
      {
        status: 400,
        apiCode: "INVALID_REPO",
        hint: check.fix
          ? `To repair it, run this in the folder: ${check.fix}`
          : "Choose a folder that contains a working Git repository.",
      },
    );
}
interface Registry {
  display_name: string | null;
  id: string;
  path: string;
  root_commit: string;
  remote_url: string | null;
  status: ProjectRow["status"];
  tracked_dir_id: string | null;
  added_at: string;
}
export class Projects {
  private identities = new Map<
    string,
    Promise<{ currentUserEmail?: string; currentUserName?: string }>
  >();
  private opening = new Map<string, ReturnType<typeof openProject>>();
  /** Last computed row per project, served first by cachedList (stale-while-revalidate). */
  private rows = new Map<string, ProjectRow>();
  private refreshing?: Promise<ProjectRow[]>;
  private stores = new Map<string, Awaited<ReturnType<typeof openProject>>>();
  constructor(
    readonly db: Database.Database,
    readonly home: string,
  ) {}
  registry() {
    return this.db.prepare("SELECT * FROM projects").all() as Registry[];
  }
  dirs() {
    return this.db.prepare("SELECT * FROM tracked_dirs").all() as TrackedDir[];
  }
  async close() {
    await this.refreshing?.catch(() => {});
    for (const s of this.stores.values()) await s.close();
    this.stores.clear();
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as
      Registry | undefined;
    if (!row) throw Object.assign(Error("That project isn't tracked any more. Go back to Projects and pick it again."), { status: 404 });
    return row;
  }
  async store(id: string) {
    const row = this.get(id);
    await resolveSafe(row.path, [row.path]);
    let store = this.stores.get(id);
    if (!store) {
      let pending = this.opening.get(id);
      if (!pending) {
        pending = openProject(row.path);
        this.opening.set(id, pending);
      }
      try {
        store = await pending;
        this.stores.set(id, store);
      } finally {
        if (this.opening.get(id) === pending) this.opening.delete(id);
      }
    }
    return store;
  }
  async safe(input: string) {
    return resolveSafe(input, [
      this.home,
      ...this.registry().map((p) => p.path),
      ...this.dirs().map((d) => d.path),
    ]);
  }
  private async explicitRoot(input: string) {
    if (input.split(/[\\/]/).includes(".."))
      throw Error("Path traversal (..) isn't allowed. Use the full folder path, such as ~/projects/app.");
    const expanded = input.replace(/^~(?=\/|$)/, this.home);
    if (!path.isAbsolute(expanded))
      throw Error("Choose an absolute folder path");
    const root = await fs.realpath(expanded);
    if (!(await fs.stat(root)).isDirectory()) throw Error("Enter a folder path to scan.");
    // An explicit scan authorizes this canonical root for subsequent tracking.
    this.db
      .prepare(
        "INSERT OR IGNORE INTO tracked_dirs(id,path,depth) VALUES(?,?,2)",
      )
      .run(randomUUID(), root);
    return root;
  }
  async addDir(root: string, depth: number) {
    const p = await this.explicitRoot(root);
    this.db
      .prepare(
        "INSERT INTO tracked_dirs(id,path,depth) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET depth=excluded.depth",
      )
      .run(randomUUID(), p, depth);
    return this.dirs();
  }
  async scan(root: string, depth: number): Promise<DiscoveredRepo[]> {
    const safe = await this.explicitRoot(root);
    await this.refreshMissing();
    const paths = await discover(safe, depth);
    // Git/metadata reads run in parallel (bounded); registry matching below stays serial.
    const probes = await mapLimit(paths, GIT_CONCURRENCY, async (p) => {
      const check = await validateRepo(p);
      return check.valid
        ? { p, check, git: await info(p), meta: await readMetadata(p) }
        : { p, check };
    });
    const result: DiscoveredRepo[] = [];
    for (const { p, check, ...probe } of probes) {
      if (!check.valid) {
        result.push({
          branch: "",
          head: "",
          remoteUrl: null,
          rootCommit: "",
          lastCommitAt: null,
          path: p,
          name: path.basename(p),
          tracked: this.registry().some((r) => r.path === p),
          invalid: true,
          reason: check.reason,
          fix: check.fix,
        });
        continue;
      }
      const git = probe.git!,
        meta = probe.meta ?? null;
      const match = this.registry().find(
        (r) =>
          r.path === p ||
          (r.status === "missing" &&
            (meta?.id === r.id ||
              (!!git.rootCommit &&
                git.rootCommit === r.root_commit &&
                git.remoteUrl === r.remote_url))),
      );
      if (match && match.path !== p) {
        await this.stores.get(match.id)?.close(p);
        this.stores.delete(match.id);
        if (meta && meta.id !== match.id)
          throw Error("This repository is already tracked under another path. Use Locate… on that project instead of adding it again.");
        this.db
          .prepare("UPDATE projects SET path=?,status='active' WHERE id=?")
          .run(p, match.id);
        if (!meta) {
          const s = await this.store(match.id);
          await s.updateProject({ id: match.id });
        }
      }
      result.push({
        ...git,
        path: p,
        name: meta?.name || path.basename(p),
        tracked: !!match,
      });
    }
    this.db
      .prepare("UPDATE tracked_dirs SET last_scanned_at=? WHERE path=?")
      .run(new Date().toISOString(), safe);
    return result;
  }
  async refreshMissing() {
    for (const r of this.registry()) {
      const exists = await fs
        .access(path.join(r.path, ".git"))
        .then(() => true)
        .catch(() => false);
      this.db
        .prepare("UPDATE projects SET status=? WHERE id=?")
        .run(exists ? "active" : "missing", r.id);
    }
  }
  async rescan() {
    for (const d of this.dirs())
      await this.scan(d.path, d.depth).catch(() => {});
    await this.refreshMissing();
  }
  async track(paths: string[]) {
    for (const input of paths) {
      const p = await this.safe(input);
      if (this.registry().some((r) => r.path === p)) continue;
      // Validate before openProject: a failed track must not leave .bip/ or exclude edits behind.
      await assertRepo(p);
      const s = await openProject(p);
      if (this.registry().some((r) => r.id === s.project.id)) {
        await s.close();
        await this.locate(s.project.id, p);
        continue;
      }
      const git = await info(p);
      const parent = this.dirs()
        .filter((d) => p === d.path || p.startsWith(d.path + path.sep))
        .sort((a, b) => b.path.length - a.path.length)[0];
      this.db
        .prepare(
          "INSERT INTO projects(id,path,root_commit,remote_url,status,tracked_dir_id,added_at,display_name) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          s.project.id,
          p,
          git.rootCommit,
          git.remoteUrl,
          "active",
          parent?.id || null,
          new Date().toISOString(),
          s.project.name,
        );
      this.stores.set(s.project.id, s);
    }
    return this.list();
  }
  async locate(id: string, input: string) {
    const r = this.get(id);
    const p = await this.safe(input);
    await assertRepo(p);
    const git = await info(p);
    const meta = await readMetadata(p);
    if (meta && meta.id !== id)
      throw Error("This repository is already tracked under another path. Use Locate… on that project instead of adding it again.");
    if (
      meta?.id !== id &&
      !(
        git.rootCommit &&
        git.rootCommit === r.root_commit &&
        git.remoteUrl === r.remote_url
      )
    )
      throw Error(
        "This repository does not match the project. Choose its moved folder.",
      );
    await this.stores.get(id)?.close(p);
    this.stores.delete(id);
    this.db
      .prepare("UPDATE projects SET path=?,status='active' WHERE id=?")
      .run(p, id);
    const s = await this.store(id);
    if (s.project.id !== id) await s.updateProject({ id });
    return this.row(id);
  }
  async untrack(id: string) {
    this.get(id);
    await this.stores.get(id)?.close();
    this.stores.delete(id);
    this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    this.rows.delete(id);
  }
  async deleteData(id: string, confirmName: string) {
    const s = await this.store(id);
    if (confirmName !== s.project.name)
      throw Error("Type the project name to confirm deletion");
    if (s.readOnly) throw Error("This project is read-only because another Build in Public process holds its lock. Close the other instance, then reload.");
    const root = await resolveSafe(s.root, [s.repo]);
    await this.untrack(id);
    await fs.rm(root, { recursive: true });
  }
  async row(id: string): Promise<ProjectRow> {
    const row = await this.computeRow(id);
    if (this.registry().some((r) => r.id === id)) this.rows.set(id, row);
    return row;
  }
  private async computeRow(id: string): Promise<ProjectRow> {
    const r = this.get(id);
    if (r.status === "missing")
      return {
        schemaVersion: 1,
        id,
        name: r.display_name || path.basename(r.path),
        path: r.path,
        rootCommit: r.root_commit,
        remoteUrl: r.remote_url || undefined,
        lastSharedCommit: null,
        commitContext: false,
        settings: {},
        branch: "",
        head: "",
        lastCommitAt: null,
        status: "missing",
        unsharedCount: 0,
        markerLost: false,
        lastPostAt: null,
        readOnly: true,
        bipSize: 0,
      } as ProjectRow;
    const s = await this.store(id);
    this.db
      .prepare("UPDATE projects SET display_name=? WHERE id=?")
      .run(s.project.name, id);
    const git = await info(r.path);
    const count = await countSince(
      r.path,
      s.project.lastSharedCommit,
      s.project.lastSharedDate,
    );
    return {
      ...s.project,
      ...git,
      remoteUrl: git.remoteUrl || undefined,
      path: r.path,
      status: r.status,
      ...(await (() => {
        if (!this.identities.has(id))
          this.identities.set(
            id,
            Promise.all(
              ["user.email", "user.name"].map((key) =>
                runGit(r.path, ["config", key])
                  .then((s) => s.trim())
                  .catch(() => undefined),
              ),
            ).then(([currentUserEmail, currentUserName]) => ({
              currentUserEmail,
              currentUserName,
            })),
          );
        return this.identities.get(id)!;
      })()),
      unsharedCount: count.count,
      markerLost: count.markerLost,
      lastPostAt:
        (
          await Promise.all(
            (await s.listStories()).map((story) => s.listPosts(story.id)),
          )
        )
          .flat()
          .map((post) => post.publishedAt || "")
          .sort()
          .at(-1) || null,
      readOnly: s.readOnly,
      bipSize: await folderSize(s.root),
    } as ProjectRow;
  }
  /** Fresh rows for every tracked project (git calls bounded by GIT_CONCURRENCY). */
  async list() {
    await this.refreshMissing();
    // Reuse a background refresh that is already running instead of duplicating its git calls.
    const inflight = this.refreshing
      ? await this.refreshing.catch(() => [] as ProjectRow[])
      : [];
    const done = new Map(inflight.map((r) => [r.id, r]));
    return (
      await mapLimit(
        this.registry(),
        GIT_CONCURRENCY,
        async (r) => done.get(r.id) ?? this.row(r.id),
      )
    ).sort(byUnshared);
  }
  /** Recomputes every row in the background; concurrent callers share one run. */
  refresh() {
    this.refreshing ??= (async () => {
      try {
        await this.refreshMissing();
        const rows = await mapLimit(this.registry(), GIT_CONCURRENCY, (r) =>
          this.row(r.id),
        );
        return rows;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
  /**
   * Stale-while-revalidate: returns the cached rows immediately (stale: true) and starts a
   * background refresh. Falls back to a fresh list when any tracked project has no cached row.
   */
  async cachedList(): Promise<{ rows: ProjectRow[]; stale: boolean }> {
    await this.refreshMissing();
    const registry = this.registry();
    if (!registry.every((r) => r.status === "missing" || this.rows.has(r.id)))
      return { rows: await this.list(), stale: false };
    void this.refresh().catch(() => {});
    const rows = await Promise.all(
      registry.map((r) =>
        r.status === "missing"
          ? this.computeRow(r.id)
          : { ...this.rows.get(r.id)!, status: r.status },
      ),
    );
    return { rows: rows.sort(byUnshared), stale: true };
  }
}
