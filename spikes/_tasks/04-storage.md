# Spike: `.bip/` storage (PoC-5)

Folder: `spikes/storage/`

Goal: prove the in-repo `.bip/` file store is safe under concurrency, migrations, and git workflows. See `docs/plan.md` §D, §E, §G for the layout and schemas.

Build `store.ts` (run with `node --experimental-strip-types`, deps: `zod`) providing:
- `openProject(repoPath)` → resolves `.bip/` and acquires `.bip/.lock` (`{pid, startedAt}`, created with `O_EXCL`; stale-lock detection when the pid is dead; a second live opener gets a **read-only** handle).
- `ensureExcluded(repoPath)` → appends `.bip/` to `<git-common-dir>/info/exclude` (from `git rev-parse --git-common-dir`; works in worktrees), idempotently.
- `optInCommitContext(repoPath)` → removes the exclude line and writes `.bip/.gitignore` = `*\n!.gitignore\n!context.md\n`. Also `optOut`.
- Atomic JSON write (temp file in the same dir + fsync + rename + fsync dir), zod-validated reads, append-only `revisions.jsonl` (handle a torn last line on read by ignoring it, and report it).
- `createStory`, `createPost`, `addRevision`, `listStories`, matching the schemas in plan §G, with `schemaVersion`.
- A per-project async mutex in-process.
- `migrate`: define a v1 → v2 change for `post.json` (e.g. rename `media[].assetSha` → `media[].sha`), lazy migrate-on-read with a copy to `.bip/.backup/<file>.<ts>` first.
- `putAsset(file)` → sha256 content-addressed copy into `.bip/assets/` (dedupe, read-only mode).

Tests (`test.ts`, run with `node --test --experimental-strip-types`), all using scratch repos under `/tmp/bip-spike-storage/`:
1. A fresh repo plus BIP writes → `git status --porcelain` is empty.
2. The same in a `git worktree add` checkout → status is clean in both the worktree and the main repo; `info/exclude` is written once, in the common dir.
3. Opt-in → status shows only `.bip/.gitignore` and `.bip/context.md` as untracked; `private.md`, stories, and assets are not shown. Opt-out restores a clean status.
4. Concurrency: 200 concurrent `addRevision` calls across 20 posts in one process → all 200 lines present and parseable. Then 2 separate processes open the same project → the second is read-only and its writes are rejected.
5. Crash safety: kill a child process mid-write in a loop (≈50 iterations, SIGKILL at random delays) → `post.json` is always either old or new valid JSON, never corrupt; a torn JSONL tail is tolerated.
6. Migration: a v1 post file is read as v2, with a backup created; a second read doesn't re-migrate.
7. Moved repo: `mv` the repo dir → reopening at the new path finds the same `project.json` id and root commit.
8. `git clean -fdx` → `.bip/` is deleted. (Document this as a confirmed data-loss path.) Also check `git stash -u` and `git checkout` of another branch leave `.bip/` intact.
9. Asset dedupe: putting the same file twice stores it once.

RESULT.md: the test table, plus measured write latency (p50/p95) for `addRevision` and `createPost`.
