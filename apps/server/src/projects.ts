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
import { info, discover, countSince, git as runGit } from "./git.js";
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
    for (const s of this.stores.values()) await s.close();
    this.stores.clear();
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as
      | Registry
      | undefined;
    if (!row) throw Object.assign(Error("Project not found"), { status: 404 });
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
      throw Error("Path traversal rejected");
    const expanded = input.replace(/^~(?=\/|$)/, this.home);
    if (!path.isAbsolute(expanded))
      throw Error("Choose an absolute folder path");
    const root = await fs.realpath(expanded);
    if (!(await fs.stat(root)).isDirectory()) throw Error("Choose a folder");
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
    const result: DiscoveredRepo[] = [];
    for (const p of paths) {
      const git = await info(p);
      const meta = await readMetadata(p);
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
          throw Error("Repository identity conflicts with tracked project");
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
      if (!(await fs.lstat(path.join(p, ".git"))))
        throw Error("Choose a Git repository root");
      if (this.registry().some((r) => r.path === p)) continue;
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
    const git = await info(p);
    const meta = await readMetadata(p);
    if (meta && meta.id !== id)
      throw Error("Repository identity conflicts with tracked project");
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
  }
  async deleteData(id: string, confirmName: string) {
    const s = await this.store(id);
    if (confirmName !== s.project.name)
      throw Error("Type the project name to confirm deletion");
    if (s.readOnly) throw Error("Project is read-only");
    const root = await resolveSafe(s.root, [s.repo]);
    await this.untrack(id);
    await fs.rm(root, { recursive: true });
  }
  async row(id: string): Promise<ProjectRow> {
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
  async list() {
    await this.refreshMissing();
    return (await Promise.all(this.registry().map((r) => this.row(r.id)))).sort(
      (a, b) =>
        b.unsharedCount - a.unsharedCount || a.name.localeCompare(b.name),
    );
  }
}
