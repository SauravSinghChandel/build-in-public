import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const contextIgnore = "*\n!.gitignore\n!context.md\n";
import { Project, Story, PostV1, Post, Revision } from "@bip/shared";
const id = z.uuid();
const platform = z.enum(["x", "linkedin"]);
const locks = new Map<string, Promise<unknown>>();
async function mutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
function missing(e: any) {
  return e.code === "ENOENT";
}
async function git(repo: string, ...args: string[]) {
  return (await exec("git", args, { cwd: repo, timeout: 10000 })).stdout.trim();
}
async function rootCommit(repo: string) {
  try {
    await git(repo, "rev-parse", "--verify", "--quiet", "HEAD");
  } catch (e: any) {
    if (e.code === 1) return "";
    throw e;
  }
  return (await git(repo, "rev-list", "--max-parents=0", "HEAD")).split(
    "\n",
  )[0];
}
async function syncDir(dir: string) {
  const fd = await fs.open(dir, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function atomicJsonWrite(file: string, value: unknown) {
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}
async function atomicWrite(file: string, text: string | Buffer, mode = 0o600) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let fd;
  try {
    fd = await fs.open(temp, "wx", mode);
    await fd.writeFile(text);
    await fd.sync();
    await fd.close();
    fd = undefined;
    await fs.rename(temp, file);
    await syncDir(path.dirname(file));
  } finally {
    await fd?.close();
    await fs.unlink(temp).catch((e) => {
      if (!missing(e)) throw e;
    });
  }
}
async function read<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // malformed locks fail closed
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== "ESRCH";
  }
}
async function acquire(
  file: string,
): Promise<null | ((relocatedFile?: string) => Promise<void>)> {
  const payload = { pid: process.pid, startedAt: new Date().toISOString() };
  async function attempt() {
    let fd;
    try {
      fd = await fs.open(file, "wx", 0o600);
    } catch (e: any) {
      if (e.code === "EEXIST") return null;
      throw e;
    }
    try {
      await fd.writeFile(JSON.stringify(payload));
      await fd.sync();
    } catch (e) {
      await fd.close();
      await fs.unlink(file);
      throw e;
    }
    const owned = await fd.stat();
    await fd.close();
    return async (relocatedFile = file) => {
      const current = await fs.lstat(relocatedFile).catch((e) => {
        if (!missing(e)) throw e;
        return null;
      });
      if (current && current.ino === owned.ino && current.dev === owned.dev) {
        await fs.unlink(relocatedFile);
        await syncDir(path.dirname(relocatedFile));
      }
    };
  }
  const first = await attempt();
  if (first) return first;
  // Never steal a live, partially written, or malformed lock. Serialize stale reapers.
  let old;
  try {
    old = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (alive(old.pid)) return null;
  const reclaim = file + ".reclaim";
  let guard;
  try {
    guard = await fs.open(reclaim, "wx", 0o600);
  } catch (e: any) {
    if (e.code === "EEXIST") return null;
    throw e;
  }
  try {
    const current = JSON.parse(
      await fs.readFile(file, "utf8").catch((e) => {
        if (!missing(e)) throw e;
        return "{}";
      }),
    );
    if (current.pid && alive(current.pid)) return null;
    await fs.unlink(file).catch((e) => {
      if (!missing(e)) throw e;
    });
    return await attempt();
  } finally {
    await guard.close();
    await fs.unlink(reclaim);
  }
}
async function exclude(repo: string, enabled: boolean) {
  const common = path.resolve(
    repo,
    await git(repo, "rev-parse", "--git-common-dir"),
  );
  const info = path.join(common, "info");
  await fs.mkdir(info, { recursive: true });
  const file = path.join(info, "exclude");
  return mutex(file, async () => {
    let release = null;
    for (let i = 0; i < 200 && !release; i++) {
      release = await acquire(file + ".bip-lock");
      if (!release) await new Promise((r) => setTimeout(r, 10));
    }
    if (!release) throw Error("Git exclude lock busy; retry");
    try {
      const text = await fs.readFile(file, "utf8").catch((e) => {
        if (!missing(e)) throw e;
        return "";
      });
      const lines = text.split("\n").filter((line) => line.trim() !== ".bip/");
      if (enabled) {
        while (lines.at(-1) === "") lines.pop();
        lines.push(".bip/", "");
      }
      const next = lines.join("\n");
      if (next !== text) await atomicWrite(file, next);
      return file;
    } finally {
      await release();
    }
  });
}
export async function ensureExcluded(repoPath: string) {
  return exclude(await fs.realpath(repoPath), true);
}

export async function openProject(repoPath: string) {
  const repo = await fs.realpath(repoPath);
  const root = path.join(repo, ".bip");
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink())
    throw Error("Symlink .bip rejected");
  // Check every existing internal path component before filesystem access.
  async function safe(...parts: string[]) {
    const target = path.join(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep))
      throw Error("Path escape rejected");
    let cursor = repo;
    for (const part of path.relative(repo, target).split(path.sep)) {
      cursor = path.join(cursor, part);
      const s = await fs.lstat(cursor).catch((e) => {
        if (!missing(e)) throw e;
        return null;
      });
      if (s?.isSymbolicLink()) throw Error("Symlink store path rejected");
    }
    return target;
  }
  return mutex(root, async () => {
    const release = await acquire(await safe(".lock"));
    const readOnly = !release;
    let closed = false;
    const writable = () => {
      if (closed) throw Error("Handle closed");
      if (readOnly)
        throw Error("Project is read-only: live or unrecoverable lock");
    };
    const write = <T>(fn: () => Promise<T>) =>
      mutex(root, async () => {
        writable();
        return fn();
      });
    const projectFile = await safe("project.json");
    let project: z.infer<typeof Project>;
    try {
      try {
        // A second process can observe the lock before the owner initializes metadata.
        for (let attempt = 0; ; attempt++) {
          try {
            project = await read(projectFile, Project);
            break;
          } catch (e) {
            if (!readOnly || !missing(e) || attempt >= 200) throw e;
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      } catch (e) {
        if (!missing(e) || readOnly) throw e;
        let remoteUrl: string | undefined;
        try {
          remoteUrl = await git(repo, "remote", "get-url", "origin");
        } catch {}
        project = Project.parse({
          schemaVersion: 1,
          id: randomUUID(),
          name: path.basename(repo),
          rootCommit: await rootCommit(repo),
          remoteUrl,
          commitContext: false,
          settings: {},
        });
        await ensureExcluded(repo);
        await atomicJsonWrite(projectFile, project);
        await atomicWrite(await safe("context.md"), "# Project context\n");
        await atomicWrite(await safe("private.md"), "# Private notes\n");
      }
      if (!readOnly) {
        if (!project.rootCommit) {
          const first = await rootCommit(repo);
          if (first) {
            project = Project.parse({ ...project, rootCommit: first });
            await atomicJsonWrite(projectFile, project);
          }
        }
        // Common excludes can be removed by opt-in in a different worktree.
        // Keep private content ignored even when that shared rule disappears.
        await atomicWrite(await safe(".gitignore"), contextIgnore);
        if (!project.commitContext) await ensureExcluded(repo);
      }
    } catch (e) {
      await release?.();
      throw e;
    }
    const storyDir = (storyId: string) => safe("stories", id.parse(storyId));
    const postFile = (storyId: string, postId: string, file = "post.json") =>
      safe("stories", id.parse(storyId), "posts", id.parse(postId), file);
    async function migrateInternal(storyId: string, postId: string) {
      const file = await postFile(storyId, postId);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (raw.schemaVersion === 2)
        return { post: Post.parse(raw), migrated: false, persisted: false };
      const v1 = PostV1.parse(raw);
      const post = Post.parse({
        ...v1,
        schemaVersion: 2,
        media: v1.media.map(({ assetSha, ...rest }) => ({
          ...rest,
          sha: assetSha,
        })),
      });
      let backup: string | undefined;
      if (!readOnly) {
        writable();
        const dir = await safe(
          ".backup",
          path.relative(root, path.dirname(file)),
        );
        await fs.mkdir(dir, { recursive: true });
        backup = path.join(dir, `post.json.${Date.now()}.${randomUUID()}`);
        await atomicWrite(backup, await fs.readFile(file));
        await atomicJsonWrite(file, post);
      }
      return { post, migrated: true, persisted: !readOnly, backup };
    }
    async function revisionsInternal(storyId: string, postId: string) {
      const file = await postFile(storyId, postId, "revisions.jsonl");
      const bytes = await fs.readFile(file, "utf8").catch((e) => {
        if (!missing(e)) throw e;
        return "";
      });
      const lines = bytes.split("\n");
      const tail = lines.pop()!;
      // Only newline-terminated records are committed; even a parseable tail is torn.
      // Manual edit snapshots remain append-only on disk. The timeline folds each
      // coalesced snapshot into the logical revision it supersedes.
      const revisions: z.infer<typeof Revision>[] = [];
      for (const line of lines) {
        const next = Revision.parse(JSON.parse(line));
        const previous = next.coalescesRevisionId
          ? revisions.findIndex((r) => r.id === next.coalescesRevisionId)
          : -1;
        if (previous >= 0) revisions[previous] = next;
        else revisions.push(next);
      }
      return {
        revisions,
        tornTail: tail.length > 0,
        ignoredTailBytes: Buffer.byteLength(tail),
      };
    }
    return {
      root,
      repo,
      readOnly,
      get project() {
        return project;
      },
      async close(relocatedRepo?: string) {
        await mutex(root, async () => {
          if (!closed) {
            closed = true;
            await release?.(
              relocatedRepo
                ? path.join(relocatedRepo, ".bip", ".lock")
                : undefined,
            );
            if (relocatedRepo) await release?.();
          }
        });
      },
      async updateProject(input: Partial<z.infer<typeof Project>>) {
        return write(async () => {
          project = Project.parse({ ...project, ...input });
          await atomicJsonWrite(projectFile, project);
          return project;
        });
      },
      async advanceShared(sha: string) {
        return write(async () => {
          if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error("Invalid marker");
          if (project.lastSharedCommit) {
            try {
              await git(
                repo,
                "merge-base",
                "--is-ancestor",
                project.lastSharedCommit,
                sha,
              );
            } catch {
              return false;
            }
          }
          project = Project.parse({
            ...project,
            lastSharedCommit: sha,
            lastSharedDate: (
              await git(repo, "show", "-s", "--format=%cI", sha)
            ).trim(),
          });
          await atomicJsonWrite(projectFile, project);
          return true;
        });
      },
      async readContext() {
        return mutex(root, async () => ({
          shareable: await fs.readFile(await safe("context.md"), "utf8"),
          private: await fs.readFile(await safe("private.md"), "utf8"),
        }));
      },
      async writeContext(input: { shareable: string; private: string }) {
        return write(async () => {
          await atomicWrite(await safe("context.md"), input.shareable);
          await atomicWrite(await safe("private.md"), input.private);
        });
      },
      async createStory(
        input: Partial<z.infer<typeof Story>> & { title: string },
      ) {
        return write(async () => {
          const now = new Date().toISOString();
          const story = Story.parse({
            schemaVersion: 1,
            id: randomUUID(),
            brief: "",
            status: "idea",
            compositionIds: [],
            createdAt: now,
            updatedAt: now,
            ...input,
          });
          const dir = await storyDir(story.id);
          await fs.mkdir(dir, { recursive: true });
          const file = await safe("stories", story.id, "story.json");
          try {
            await fs.access(file);
            throw Error("Story already exists");
          } catch (e) {
            if (!missing(e)) throw e;
          }
          await atomicJsonWrite(file, story);
          return story;
        });
      },
      async readStory(storyId: string) {
        return mutex(root, async () =>
          read(await safe("stories", id.parse(storyId), "story.json"), Story),
        );
      },
      async updateStory(
        storyId: string,
        input: Partial<z.infer<typeof Story>>,
      ) {
        return write(async () => {
          const file = await safe("stories", id.parse(storyId), "story.json");
          const current = await read(file, Story);
          const next = Story.parse({
            ...current,
            ...input,
            id: current.id,
            updatedAt: new Date().toISOString(),
          });
          await atomicJsonWrite(file, next);
          return next;
        });
      },
      async listPosts(storyId: string) {
        return mutex(root, async () => {
          await read(
            await safe("stories", id.parse(storyId), "story.json"),
            Story,
          );
          const dir = await safe("stories", id.parse(storyId), "posts");
          const entries = await fs.readdir(dir).catch((e) => {
            if (!missing(e)) throw e;
            return [];
          });
          return Promise.all(
            entries.map(
              async (entry) =>
                (await migrateInternal(storyId, id.parse(entry))).post,
            ),
          );
        });
      },
      async updatePost(
        storyId: string,
        postId: string,
        input: Partial<z.infer<typeof Post>>,
        expectedRevisionId?: string,
      ) {
        return write(async () => {
          const current = (await migrateInternal(storyId, postId)).post;
          if (
            expectedRevisionId &&
            current.currentRevisionId !== expectedRevisionId
          )
            throw Error("The post changed. Review its latest revision.");
          const next = Post.parse({
            ...current,
            ...input,
            id: current.id,
            storyId: current.storyId,
          });
          await atomicJsonWrite(await postFile(storyId, postId), next);
          return next;
        });
      },
      async writeSummary(text: string) {
        return write(async () =>
          atomicWrite(await safe("auto-summary.md"), text),
        );
      },
      async readSummary() {
        return mutex(root, async () =>
          fs.readFile(await safe("auto-summary.md"), "utf8").catch((e) => {
            if (!missing(e)) throw e;
            return "";
          }),
        );
      },
      async createPost(
        storyId: string,
        input: Partial<z.infer<typeof Post>> & {
          platform: z.infer<typeof platform>;
        },
      ) {
        return write(async () => {
          await read(
            await safe("stories", id.parse(storyId), "story.json"),
            Story,
          );
          const post = Post.parse({
            schemaVersion: 2,
            id: randomUUID(),
            kind: "post",
            currentRevisionId: "",
            status: "draft",
            media: [],
            ...input,
            storyId,
          });
          const file = await postFile(storyId, post.id);
          await fs.mkdir(path.dirname(file), { recursive: true });
          try {
            await fs.access(file);
            throw Error("Post already exists");
          } catch (e) {
            if (!missing(e)) throw e;
          }
          await atomicJsonWrite(file, post);
          return post;
        });
      },
      async listStories() {
        return mutex(root, async () => {
          const dir = await safe("stories");
          const entries = await fs.readdir(dir).catch((e) => {
            if (!missing(e)) throw e;
            return [];
          });
          return Promise.all(
            entries.map(async (entry) =>
              read(await safe("stories", id.parse(entry), "story.json"), Story),
            ),
          );
        });
      },
      async migrate(storyId: string, postId: string) {
        return mutex(root, () => migrateInternal(storyId, postId));
      },
      async readPost(storyId: string, postId: string) {
        return mutex(
          root,
          async () => (await migrateInternal(storyId, postId)).post,
        );
      },
      async readRevisions(storyId: string, postId: string) {
        return mutex(root, () => revisionsInternal(storyId, postId));
      },
      async addRevision(
        storyId: string,
        postId: string,
        input: {
          parts: string[];
          author: "user" | "agent";
          instruction?: string;
          agentRunId?: string;
          claims?: string[];
          highlights?: string[];
          coalesce?: boolean;
        },
      ) {
        return write(async () => {
          const post = (await migrateInternal(storyId, postId)).post;
          if ((await revisionsInternal(storyId, postId)).tornTail)
            throw Error("Torn revision tail: recover before appending");
          const previous = (await revisionsInternal(storyId, postId)).revisions;
          const last = previous.at(-1);
          const coalesce =
            input.coalesce &&
            input.author === "user" &&
            !input.instruction &&
            last?.author === "user" &&
            !last.instruction &&
            Date.now() - Date.parse(last.createdAt) < 60000 &&
            last.id === post.currentRevisionId;
          const revision = Revision.parse({
            ...Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== "coalesce"),
            ),
            schemaVersion: 1,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
          });
          if (coalesce) {
            revision.createdAt = last!.createdAt;
            revision.editedAt = new Date().toISOString();
            revision.coalescesRevisionId = last!.id;
          }
          const file = await postFile(storyId, postId, "revisions.jsonl");
          const fd = await fs.open(file, "a", 0o600);
          try {
            await fd.writeFile(JSON.stringify(revision) + "\n");
            await fd.sync();
          } finally {
            await fd.close();
          }
          await syncDir(path.dirname(file));
          await atomicJsonWrite(await postFile(storyId, postId), {
            ...post,
            currentRevisionId: revision.id,
            kind:
              post.kind === "follow_up"
                ? "follow_up"
                : post.platform === "x" && input.parts.length > 1
                  ? "thread"
                  : "post",
            approvedRevisionId: undefined,
            status: "draft",
          });
          const storyPath = await safe(
            "stories",
            id.parse(storyId),
            "story.json",
          );
          const story = await read(storyPath, Story);
          await atomicJsonWrite(storyPath, {
            ...story,
            updatedAt: new Date().toISOString(),
          });
          return revision;
        });
      },
      async optInCommitContext() {
        return write(async () => {
          await atomicWrite(await safe(".gitignore"), contextIgnore);
          project = Project.parse({ ...project, commitContext: true });
          await atomicJsonWrite(projectFile, project);
          await exclude(repo, false);
        });
      },
      async optOut() {
        return write(async () => {
          await ensureExcluded(repo);
          project = Project.parse({ ...project, commitContext: false });
          await atomicJsonWrite(projectFile, project);
        });
      },
      async putAsset(file: string) {
        return write(async () => {
          const bytes = await fs.readFile(file);
          const hash = createHash("sha256").update(bytes).digest("hex");
          // Canonical hash-only names dedupe equal bytes regardless of input extension.
          const dir = await safe("assets");
          await fs.mkdir(dir, { recursive: true });
          const target = await safe("assets", hash);
          try {
            if (
              createHash("sha256")
                .update(await fs.readFile(target))
                .digest("hex") !== hash
            )
              throw Error("Asset hash mismatch");
          } catch (e) {
            if (!missing(e)) throw e;
            await atomicWrite(target, bytes, 0o444);
          }
          return { sha: hash, path: target };
        });
      },
    };
  });
}
export async function optInCommitContext(repo: string) {
  const store = await openProject(repo);
  try {
    await store.optInCommitContext();
  } finally {
    await store.close();
  }
}
export async function optOut(repo: string) {
  const store = await openProject(repo);
  try {
    await store.optOut();
  } finally {
    await store.close();
  }
}
