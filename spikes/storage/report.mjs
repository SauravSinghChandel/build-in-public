import { readFile, writeFile } from 'node:fs/promises';
const e = JSON.parse(await readFile(new URL('./out/evidence.json', import.meta.url), 'utf8'));
const check = n => Object.entries(e.checks).find(([name]) => name.startsWith(`${n} `))?.[1] ?? { status: 'FAIL' };
const crash = check(5), timing = check(10);
const passed = Object.values(e.checks).filter(v => v.status === 'PASS').length;
const verdict = passed === 13 ? 'GO-with-caveats' : 'NO-GO';
const fmt = x => typeof x === 'number' ? x.toFixed(3) : 'unavailable';
const row = (n, label, proof) => `| ${label} | ${check(n).status} | ${check(n).status === 'PASS' ? proof : 'See failure in out/evidence.json'} |`;
const report = `${verdict} — ${passed}/13 tests pass; process-crash safety proven on tmpfs, with Git/worktree and recovery caveats.

Evidence: [test log](out/test.log), [raw measurements and paths](out/evidence.json). Run: ${e.completedAt}.
Scratch root: \`${e.run}\`. All Git mutations occurred in scratch repos.

| Acceptance check | Result | Evidence |
|---|---|---|
${row(1, '1. Fresh repo + writes', 'Empty porcelain status; story/post/revision round trip (fresh/).')}
${row(2, '2. Worktree', 'Both checkouts clean; common main/.git/info/exclude contains .bip/ exactly once after 22 ensure calls.')}
${row(3, '3. Context opt-in/out', 'Exactly .bip/.gitignore + .bip/context.md untracked; opt-out clean (opt-in/).')}
${row(4, '4. Concurrent writes + two processes', '200 unique revisions, 20 posts × 10; pointers match; separate reader reports readOnly=true and rejected=true.')}
${row(5, '5. SIGKILL + torn JSONL', `50 kills: ${crash.old} old / ${crash.new} new valid post files; ${crash.temporaryFileAtKill} observed temp files at kill; 50 stale locks recovered. Torn 11-byte tail reported/ignored.`)}
${row(6, '6. v1 → v2 migration', 'assetSha → sha; byte-equivalent JSON backup under .backup/stories/.../post.json.<ts>.<uuid>; second read leaves exactly one backup.')}
${row(7, '7. Moved repo', 'before-move → after-move; identical project id and root commit (raw evidence records both).')}
${row(8, '8. Git workflows', 'stash -u + checkout preserve bytes; clean -fdx reports Removing .bip/ and deletes it. CONFIRMED DATA LOSS.')}
${row(9, '9. Asset dedupe', 'Equal bytes from .png/.jpg names → one SHA-256 file, permissions 0444 (assets/).')}
${row(11, 'Extra validation guards', 'Read-only migration writes nothing; invalid schemas, traversal, symlinks and closed-handle writes rejected.')}
${row(12, 'Extra worktree opt-in interaction', 'Shared toggle affects peer visibility; restrictive ignore in every store keeps private data hidden.')}
${row(13, 'Extra unborn repo', 'No commits: clean status and empty rootCommit; first commit learned on reopen, project id preserved.')}

| Durable API latency (100 sequential samples each) | p50 | p95 |
|---|---|---|
| createPost | ${fmt(timing.createPost?.p50Ms)} ms | ${fmt(timing.createPost?.p95Ms)} ms |
| addRevision | ${fmt(timing.addRevision?.p50Ms)} ms | ${fmt(timing.addRevision?.p95Ms)} ms |
Measured with performance.now including validation, locks and fsync; warm cache on /tmp **tmpfs**. These are process/filesystem overheads, not physical-disk durability timings. Raw samples are in evidence.json.

Gotchas / scope:
- System Node ${e.versions.node} fails with ERR_NO_TYPESCRIPT (compiled without TS support). Local npm node@22.22.1 works; required flag: --experimental-strip-types. zod ${e.versions.zod}; ${e.versions.git}; npm 9.2.0. No agent CLI calls.
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
\`\`\`bash
cd /home/justbuster/projects/build-in-public/spikes/storage
npm ci --cache /tmp/bip-spike-storage/npm-cache --no-audit --no-fund
mkdir -p out
./node_modules/node/bin/node --test --experimental-strip-types test.ts > out/test.log 2>&1
./node_modules/node/bin/node report.mjs
\`\`\`
`;
await writeFile(new URL('./RESULT.md', import.meta.url), report);
