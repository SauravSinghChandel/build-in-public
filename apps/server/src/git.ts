import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { GitInfo, Commit } from "@bip/shared";
const exec = promisify(execFile);
export async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
) {
  return (
    await exec("git", args, {
      cwd,
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
  ).stdout;
}
export type RepoCheck =
  { valid: true } | { valid: false; reason: string; fix?: string };
const isFile = (p: string) =>
  fs
    .lstat(p)
    .then((s) => s.isFile())
    .catch(() => false);
const isDir = (p: string) =>
  fs
    .lstat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
/** Checks that `repo` itself is a working Git repository root (no walking up to a parent repo). */
export async function validateRepo(repo: string): Promise<RepoCheck> {
  const dotGit = path.join(repo, ".git");
  const stat = await fs.lstat(dotGit).catch(() => null);
  const broken = "Not a valid Git repository (.git is empty or broken)";
  if (!stat) return { valid: false, reason: "Not a Git repository (no .git)" };
  try {
    const top = (
      await git(repo, ["rev-parse", "--show-toplevel"], {
        GIT_CEILING_DIRECTORIES: path.dirname(repo),
      })
    ).trim();
    if (top && (await fs.realpath(top)) === (await fs.realpath(repo)))
      return { valid: true };
  } catch {}
  if (stat.isDirectory() && !(await fs.readdir(dotGit)).length) {
    for (const e of await fs.readdir(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git") continue;
      const dir = path.join(repo, e.name);
      if (
        (await isFile(path.join(dir, "HEAD"))) &&
        (await isFile(path.join(dir, "config"))) &&
        (await isDir(path.join(dir, "objects")))
      )
        return {
          valid: false,
          reason: `${broken}. .git is an empty folder; the Git data looks like it is in ${e.name}/.`,
          fix: `rmdir .git && printf 'gitdir: ${e.name}\\n' > .git`,
        };
    }
  }
  return { valid: false, reason: broken };
}
const cache = new Map<string, unknown>();
async function cached<T>(
  repo: string,
  key: string,
  fn: () => Promise<T>,
  knownHead?: string,
): Promise<T> {
  const head =
    knownHead ??
    (await git(repo, ["rev-parse", "--verify", "HEAD"])
      .then((x) => x.trim())
      .catch(() => ""));
  const k = JSON.stringify([repo, head, key]);
  if (cache.has(k)) return cache.get(k) as T;
  const value = await fn();
  if (cache.size > 500) cache.clear();
  cache.set(k, value);
  return value;
}
export async function info(repo: string): Promise<GitInfo> {
  // Independent lookups run in parallel; branch and origin may change without changing HEAD,
  // so only immutable commit data is cached.
  const [head, symbolic, remoteUrl] = await Promise.all([
    git(repo, ["rev-parse", "--verify", "HEAD"])
      .then((x) => x.trim())
      .catch(() => ""),
    git(repo, ["symbolic-ref", "--short", "HEAD"])
      .then((x) => x.trim())
      .catch(() => null),
    git(repo, ["remote", "get-url", "origin"])
      .then((x) => x.trim())
      .catch(() => null),
  ]);
  const branch = symbolic ?? `detached at ${head.slice(0, 7)}`;
  const commit = await cached(
    repo,
    "info",
    async () => ({
      rootCommit: head
        ? (await git(repo, ["rev-list", "--max-parents=0", "HEAD"]))
            .trim()
            .split("\n")[0]
        : "",
      lastCommitAt: head
        ? (await git(repo, ["show", "-s", "--format=%cI", "HEAD"])).trim()
        : null,
    }),
    head,
  );
  return { branch, head, remoteUrl, ...commit };
}
export function parseLog(output: string): Commit[] {
  return output
    .split("\x1e")
    .slice(1)
    .map((record) => {
      const [sha, subject, body, authorName, authorEmail, date, ...tail] =
        record.split("\x1f");
      const files = tail
        .join("\x1f")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [a, d, ...file] = line.split("\t");
          return {
            path: file.join("\t"),
            insertions: Number(a) || 0,
            deletions: Number(d) || 0,
          };
        })
        .filter((f) => f.path);
      return {
        sha,
        subject,
        body,
        authorName,
        authorEmail,
        date,
        files,
        insertions: files.reduce((a, f) => a + f.insertions, 0),
        deletions: files.reduce((a, f) => a + f.deletions, 0),
      };
    });
}
export async function log(
  repo: string,
  options: { since?: string; limit: number; offset: number },
): Promise<Commit[]> {
  return cached(repo, JSON.stringify(options), async () => {
    if (!(await info(repo)).head) return [];
    return parseLog(
      await git(repo, [
        "log",
        ...(options.since ? [`${options.since}..HEAD`] : []),
        `--max-count=${options.limit}`,
        `--skip=${options.offset}`,
        "--format=%x1e%H%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f",
        "--numstat",
        "--diff-merges=first-parent",
        "--no-renames",
      ]),
    );
  });
}
export async function countSince(
  repo: string,
  sha?: string | null,
  date?: string,
): Promise<{ count: number; markerLost: boolean }> {
  return cached(repo, `count:${sha}:${date}`, async () => {
    if (!(await info(repo)).head) return { count: 0, markerLost: !!sha };
    if (!sha)
      return {
        count: Number(await git(repo, ["rev-list", "--count", "HEAD"])),
        markerLost: false,
      };
    try {
      await git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"]);
      return {
        count: Number(await git(repo, ["rev-list", "--count", `${sha}..HEAD`])),
        markerLost: false,
      };
    } catch {
      const fallback =
        date ||
        (await git(repo, ["show", "-s", "--format=%cI", sha])
          .then((x) => x.trim())
          .catch(() => undefined));
      return {
        count: Number(
          await git(repo, [
            "rev-list",
            "--count",
            ...(fallback
              ? [
                  `--since-as-filter=${new Date(new Date(fallback).getTime() + 1000).toISOString()}`,
                ]
              : []),
            "HEAD",
          ]),
        ),
        markerLost: true,
      };
    }
  });
}
const skipped = new Set([
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "target",
  ".cache",
]);
export async function discover(root: string, depth = 2): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, level: number) {
    if (
      await fs
        .lstat(path.join(dir, ".git"))
        .then(() => true)
        .catch(() => false)
    ) {
      found.push(dir);
      return;
    }
    if (level >= depth) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && !skipped.has(e.name))
        await walk(path.join(dir, e.name), level + 1);
    }
  }
  await walk(root, 0);
  return found.sort();
}
