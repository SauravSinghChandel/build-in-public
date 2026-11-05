# M1 architecture

The pnpm workspace contains the Hono server, React browser client, and shared Zod schemas/API types. TypeScript is strict throughout. Node 22 runs compiled JavaScript in production; `tsx watch` runs the development server because this host's Node lacks TypeScript stripping.

## Run and verify

Use `npx --yes pnpm@10.34.9 install`, then `npx --yes pnpm@10.34.9 dev` or `npx --yes pnpm@10.34.9 start`. Start builds both applications and opens the token URL unless `BIP_NO_OPEN` is set. The development token URL redirects to Vite after installing the cookie. Both services use 127.0.0.1; Vite proxies `/api` to port 4310 (or `BIP_PORT`). `BIP_PORT` changes the server and development proxy port.

Run `typecheck`, `test`, and `test:e2e` with the same pnpm prefix. Use **`pnpm run doctor`** explicitly: pnpm itself also has a `doctor` command. The application CLI is `node apps/server/dist/cli.js start|doctor|backup` after building. Examples: `backup --all` and `backup --project <uuid>`.

## Persistence

`BIP_HOME` isolates all application data, including `config.json`, for tests or portable use. Otherwise data is under `$XDG_DATA_HOME/build-in-public` (default `~/.local/share/build-in-public`), and configuration is `$XDG_CONFIG_HOME/build-in-public/config.json` (default `~/.config/build-in-public/config.json`). Configuration currently stores the port; appearance is browser-local in `bip-appearance` as required by M1.

SQLite contains the folder/project registry and the future job/agent-run tables. Migrations run in numbered order, transactionally with `PRAGMA user_version`. Existing databases are checkpointed and copied before upgrades; WAL and foreign keys are enabled. Display names are cached in the registry for missing-folder rows.

`src/bip/store.ts` is ported from `spikes/storage/store.ts`, retaining its exclusive PID/reaper locks, per-resource async mutexes, Zod validation, same-directory atomic writes, fsync, revision recovery detection, content-addressed assets, and migration backups. Shared schemas live in `packages/shared`. M1 adds metadata updates and safe Markdown read/write. Project handles are retained for the server lifetime; concurrent readers reuse one opening promise. A second instance gets a read-only handle. Moving an open project releases its relocated lock only if inode/device identity still proves ownership.

The spike's caveats still apply: PID reuse/malformed locks fail closed; directory fsync is not a power-loss guarantee; revisions and their pointer are not a multi-file transaction. Git worktrees share excludes, so context opt-in can affect another checkout's visibility. Opt-out does not untrack already committed files. Private notes are ignored, not encrypted. `git clean -fdx` and deleting/recloning a repository can destroy `.bip`; the UI explains this and provides backup.

Backups use system `tar` with an argument array, writing `.tar.gz` files to `backups/<project-id>/`. Renders and the live lock are excluded. Backups do not stop another process from editing the store; they are manual snapshots, not a cross-file transaction or automatic recovery service.

## Git and identity

Discovery is depth-limited, skips generated/hidden directories, supports `.git` files, and stops at a repository. Git commands use `execFile`, a 10-second timeout, and a bounded output buffer. Logs use record/field separators and numstat; merge stats compare the first parent, binary stats are zero. Commit data and pages are cached by canonical repository path and HEAD; branch/origin are refreshed independently because they can change at the same HEAD.

The shared marker stores its SHA and commit date. When the marker is no longer an ancestor (or has been pruned), counts use commits after its saved date and report `markerLost`. Without a recoverable or saved date, the conservative fallback is all commits. SHA/date fallback cannot establish exact ancestry after arbitrary history rewrites.

Startup, manual rescans and debounced window focus scan saved folders. Missing paths are retained. Matching `.bip` IDs, or root commit plus origin, relink missing entries; manual Locate validates the same identity. Repositories without an origin can match by root commit with a null origin. Existing conflicting `.bip` IDs are rejected.

## Security boundary

The server binds only 127.0.0.1, validates Host on every request, validates Origin on mutations, and authenticates all API endpoints with an HttpOnly SameSite=Strict session cookie. A fresh 32-byte token is printed at startup; the token exchange redirects to remove it from the visible URL and responses set `Referrer-Policy: no-referrer`. Development additionally accepts the Vite Origin. `BIP_DEV_NO_AUTH=1` works only with `NODE_ENV=development`.

Autocomplete and newly selected folders are restricted to HOME. Canonical tracked repositories are the additional read roots; only their `.bip` stores are written. Traversal and symlink escapes are rejected; store paths independently reject symlinks. This does not claim protection against a hostile process racing filesystem path replacement. Agent detection invokes versions and the documented local `codex login status`; Claude authentication remains unknown. M1 never invokes an agent model.

## Client

TanStack Router owns page navigation; TanStack Query owns API caching. Owned shadcn-style components use Radix for dialogs, menus, switches and tooltips, plus cmdk for command search. The graphite/amber CSS tokens implement `docs/design.md`, with self-hosted IBM Plex, light/dark/system modes and reduced-motion handling. The timeline supports paging, expanded file lists, shift selection and shared markers. M2 enables story creation from commit selection. Context writes are serialized after 800 ms idle, flushed when leaving the tab, and reflected in the query cache.

All tests create disposable repositories under the OS temporary directory. The single Playwright core-loop test launches the compiled production server with a temporary HOME/BIP_HOME, exchanges the real token, and cleans up its process and fixtures. It never scans or modifies the user's project folders.

## M2 Post Studio

`agents/` ports M0's process harness with fresh per-job working directories, closed stdin,
read-only tools/sandbox, environment/config binary selection, JSONL normalization, persisted
session IDs, costs and raw logs. Writing tasks receive a redacted context bundle only;
summary tasks additionally receive the repository through `--add-dir`. No repository is a CLI cwd.

`jobs/runner.ts` uses SQLite as the durable queue and runs at most two jobs, excluding
concurrent resource keys. Startup changes running jobs to interrupted. Resume reuses the
last stored session for that job; independent edit actions always start new sessions.
Cookie-authenticated SSE carries a bounded 300-event replay ring. On reconnect the client
also refreshes persisted jobs, including after a server restart resets the event sequence.
Shutdown closes SSE sockets before waiting for agent cancellation and store cleanup.

Content stays in the M1 store. Revisions include claims/highlights. Manual edit snapshots
append to JSONL; snapshots within 60 seconds fold into one logical timeline revision,
with a fresh revision ID and an explicit coalescing pointer. Restore always appends.
Approval checks the current revision and rejects secret matches, unchecked claims, or
unacknowledged private-term warnings. Changes invalidate approval. Publish recording
requires approval and a matching HTTPS platform URL. The first published post of a story
advances its marker only under an atomic store lock and a successful ancestor check.

The browser has routed project tabs and feature modules, an angle sheet, a two-platform
editor, a revision diff preview, and an assisted publish sheet. It only copies text and
opens platform URLs; it contains no social-platform posting integration. Regex secret
scanning is best-effort and cannot establish factual accuracy or absence of secrets.
