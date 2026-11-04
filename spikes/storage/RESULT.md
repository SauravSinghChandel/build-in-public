GO-with-caveats — 13/13 tests pass; process-crash safety proven on tmpfs, with Git/worktree and recovery caveats.

Evidence: [test log](out/test.log), [raw measurements and paths](out/evidence.json). Run: 2026-11-04T20:09:54.257Z.
Scratch root: `/tmp/bip-spike-storage/run-o5Ebvc`. All Git mutations occurred in scratch repos.

| Acceptance check | Result | Evidence |
|---|---|---|
| 1. Fresh repo + writes | PASS | Empty porcelain status; story/post/revision round trip (fresh/). |
| 2. Worktree | PASS | Both checkouts clean; common main/.git/info/exclude contains .bip/ exactly once after 22 ensure calls. |
| 3. Context opt-in/out | PASS | Exactly .bip/.gitignore + .bip/context.md untracked; opt-out clean (opt-in/). |
| 4. Concurrent writes + two processes | PASS | 200 unique revisions, 20 posts × 10; pointers match; separate reader reports readOnly=true and rejected=true. |
| 5. SIGKILL + torn JSONL | PASS | 50 kills: 12 old / 38 new valid post files; 6 observed temp files at kill; 50 stale locks recovered. Torn 11-byte tail reported/ignored. |
| 6. v1 → v2 migration | PASS | assetSha → sha; byte-equivalent JSON backup under .backup/stories/.../post.json.<ts>.<uuid>; second read leaves exactly one backup. |
| 7. Moved repo | PASS | before-move → after-move; identical project id and root commit (raw evidence records both). |
| 8. Git workflows | PASS | stash -u + checkout preserve bytes; clean -fdx reports Removing .bip/ and deletes it. CONFIRMED DATA LOSS. |
| 9. Asset dedupe | PASS | Equal bytes from .png/.jpg names → one SHA-256 file, permissions 0444 (assets/). |
| Extra validation guards | PASS | Read-only migration writes nothing; invalid schemas, traversal, symlinks and closed-handle writes rejected. |
| Extra worktree opt-in interaction | PASS | Shared toggle affects peer visibility; restrictive ignore in every store keeps private data hidden. |
| Extra unborn repo | PASS | No commits: clean status and empty rootCommit; first commit learned on reopen, project id preserved. |

| Durable API latency (100 sequential samples each) | p50 | p95 |
|---|---|---|
| createPost | 0.797 ms | 1.280 ms |
| addRevision | 1.525 ms | 2.085 ms |
Measured with performance.now including validation, locks and fsync; warm cache on /tmp **tmpfs**. These are process/filesystem overheads, not physical-disk durability timings. Raw samples are in evidence.json.

Gotchas / scope:
- System Node v22.22.1 fails with ERR_NO_TYPESCRIPT (compiled without TS support). Local npm node@22.22.1 works; required flag: --experimental-strip-types. zod 4.3.6; git version 2.53.0; npm 9.2.0. No agent CLI calls.
- Default npm cache is read-only here; use the scratch --cache path below. Local Node binary stays in node_modules/.
- Worktrees have independent stores/locks/ids, but common excludes. Opt-in in one exposes the peer's context + ignore; opt-out/reopen in a peer can hide both. Per-checkout opt-in needs a design change. Store initialization always installs the restrictive .gitignore as a privacy guard.
- Excludes never untrack already committed context; opt-out only hides untracked files. Ignore rules are convenience, not a security boundary.
- O_EXCL uses {pid, startedAt}; dead PIDs reclaimed under a separate reaper guard. PID reuse, malformed/partial locks and orphan reaper guards fail closed; manual inspection may be needed. Crash tests kill after lock initialization, not while creating/reaping locks.
- JSON writes: same-directory exclusive temp → file fsync → rename → directory fsync. SIGKILL is not power-loss/NFS validation; killed writers can leave disposable temp files.
- Revisions are append + fsync. A non-newline tail is ignored and reported; further appends reject until explicit recovery. Append + currentRevisionId update is not a multi-file transaction: a crash can leave an unreferenced revision.
- Asset filenames are canonical hash-only (no extension) to dedupe equal content across names; MIME/index management is outside this spike. 0444 is advisory for the file owner. Existing symlinks are rejected; hostile concurrent path replacement is outside this PoC.
- node_modules/ and all generated out/ files are ignored, covering large artifacts; Git has no size-threshold ignore syntax. No nonignored artifact exceeds 20 MB.

Recommendation: use the file store for M1 with external automatic backups before destructive Git workflows; scope context opt-in across worktrees explicitly. Add revision-pointer recovery and robust OS-backed locking; benchmark durable disk and power-loss recovery before claiming stronger guarantees.

How to re-run (scratch repos only; no changes to app source or other repos):
```bash
cd /home/justbuster/projects/build-in-public/spikes/storage
npm ci --cache /tmp/bip-spike-storage/npm-cache --no-audit --no-fund
mkdir -p out
./node_modules/node/bin/node --test --experimental-strip-types test.ts > out/test.log 2>&1
./node_modules/node/bin/node report.mjs
```
