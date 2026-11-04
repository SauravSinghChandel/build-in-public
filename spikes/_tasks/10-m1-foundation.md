# Milestone M1: Foundation

You are implementing milestone **M1** of Build in Public (BIP). Read first: `docs/plan.md` (all of it, especially §B, C, D, E, G, L, and M1) and `docs/design.md` (the UI spec; follow it closely). Port the proven `.bip/` store from `spikes/storage/` (read its `RESULT.md` and code) instead of rewriting it from scratch.

Repo: `/home/justbuster/projects/build-in-public`, branch `m1-foundation` (already checked out). **Do not commit or push**; the reviewer does that. Don't modify `spikes/` or `docs/plan.md`. You may append to `docs/` (e.g. `docs/architecture.md`).

Tooling: Node 22. pnpm isn't installed globally; run it as `npx --yes pnpm@10.34.9 …` and set `"packageManager": "pnpm@10.34.9"` in the root `package.json`. Keep the pnpm store inside the repo (`.pnpm-store/`, gitignored) via `.npmrc` `store-dir=.pnpm-store` if the default store isn't writable. Use TypeScript strict mode everywhere.

## Structure
```
apps/server   Hono + @hono/node-server, better-sqlite3, zod. Entry src/index.ts; CLI src/cli.ts (bin "bip")
apps/web      React 19 + Vite + Tailwind v4 + shadcn/ui (add components into src/components/ui) + TanStack Router + TanStack Query + lucide-react + @fontsource/ibm-plex-sans + @fontsource/ibm-plex-mono + sonner
packages/shared  zod schemas + API types shared by server and web
```
Root scripts: `dev` (server with watch on :4310 + Vite on :5173 proxying `/api`), `build`, `start` (build web, then the server serves `apps/web/dist` on :4310), `test` (vitest across workspaces), `test:e2e` (Playwright), `typecheck`, `doctor` (= `bip doctor`).

## Server
- Bind **127.0.0.1:4310** only (`BIP_PORT` overrides the port). App data root = `BIP_HOME` or XDG (`~/.local/share/build-in-public`; config at `~/.config/build-in-public/config.json`).
- **Security middleware** (plan §L):
  - At startup, generate a random 32-byte session token and print `Open http://127.0.0.1:4310/?token=…`. `GET /?token=` sets an HttpOnly, SameSite=Strict cookie `bip_session` and redirects to `/`.
  - Every `/api/*` request requires the cookie.
  - Reject requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence), and state-changing requests whose `Origin` (when present) isn't the app origin.
  - In dev, accept the Vite origin. `BIP_DEV_NO_AUTH=1` skips the token only when `NODE_ENV=development`.
  - The `start` command opens the browser if `BIP_NO_OPEN` is unset (use `xdg-open`/`open` via execFile; ignore failures).
- **Paths:** a `paths.ts` with `resolveSafe()` (realpath + allowlist). The directory-autocomplete endpoint lists directories under `$HOME` only, skipping dotfolders unless typed. Tracked repo paths and their `.bip/` are the only other allowed roots.
- **Git service** (`execFile('git', args, {cwd})`, no shell, 10 s timeout):
  - `discover(root, depth=2)`: finds dirs containing `.git` (file or dir), skips `node_modules`, `.venv`, `venv`, `dist`, `build`, `.next`, `target`, `.cache`, and dot dirs; doesn't descend into a found repo.
  - `info(path)`: current branch (or "detached at <sha>"), HEAD sha, root commit (`git rev-list --max-parents=0 HEAD`, first line), origin URL, last commit time. Empty repos with no commits must not crash.
  - `log(path, {since?: sha, limit, offset})`: sha, subject, body, author name/email, ISO date, files changed, insertions, deletions (`--numstat` parsed, binary files = 0). Use a robust format with record/field separators (`%x1e`/`%x1f`).
  - `countSince(path, sha?)`: `git rev-list --count <sha>..HEAD` (all commits when sha is null); if the sha no longer exists (rebased away), fall back to commits after its date and flag `markerLost: true`.
  - Cache results keyed by (path, HEAD sha).
- **Database** `app.db` (better-sqlite3, WAL, `foreign_keys=ON`): numbered SQL migrations in `apps/server/migrations/` with `PRAGMA user_version`, and back up the db file before migrating. Tables per plan §G: tracked_dirs, projects, jobs, agent_runs (jobs and agent_runs are created now but unused).
- **`.bip` store:** port from the spike into `apps/server/src/bip/`. Tracking a project creates `.bip/project.json` (id, name, rootCommit, remoteUrl, lastSharedCommit null, commitContext false, settings {}) and runs `ensureExcluded`. Context read/write goes to `context.md` and `private.md`. Implement `optInCommitContext`/`optOut`. Lock handling per the spike.
- **Relink:** on rescan, a registry project whose path is missing gets status `missing`. Any newly discovered repo whose `.bip/project.json` id matches (or whose root commit + remote match) is re-linked automatically. There's also a manual "locate" endpoint.
- **API** (JSON, zod-validated, errors as `{error: {code, message, hint?}}`):
  - `GET /api/health`
  - `GET /api/fs/dirs?prefix=`
  - `POST /api/scan` {root, depth} → discovered repos (with `tracked` flag)
  - `GET|POST|DELETE /api/tracked-dirs`
  - `GET /api/projects` (rows for the Projects list, including `unsharedCount`, `lastPostAt: null`, status)
  - `POST /api/projects` {paths[]} (track)
  - `GET /api/projects/:id`
  - `PATCH /api/projects/:id` (name, settings)
  - `POST /api/projects/:id/untrack`
  - `POST /api/projects/:id/locate` {path}
  - `DELETE /api/projects/:id/bip-data` {confirmName}
  - `GET /api/projects/:id/commits?offset&limit`
  - `POST /api/projects/:id/mark-shared` {sha}
  - `GET|PUT /api/projects/:id/context` {shareable, private}
  - `POST /api/projects/:id/commit-context` {enabled}
  - `POST /api/projects/:id/backup`
  - `GET /api/doctor`
  - `GET /api/agents/status`: `claude --version` and `codex --version` via execFile, plus a cheap signed-in check if one is documented (`codex login status`; for claude, report "unknown" rather than making a model call)
- **CLI** `bip`: `start`, `doctor` (Node ≥ 22, git, ffmpeg, Playwright Chromium present, claude/codex versions, app data writable, port free; prints a ✓/✗ list with fix hints; exit code 1 on a hard failure), `backup [--project <id>|--all]` (tar.gz of `.bip/` minus `renders/` into `<appdata>/backups/<project-id>/<timestamp>.tar.gz`, using the system `tar` via execFile).

## Web
Implement exactly the M1 screens in `docs/design.md`: app frame with the collapsible rail and the ⌘K palette; Projects list (with empty, missing, and loading states); the two-step Add projects dialog; Project workspace (header, tabs; Overview with the unshared rail, day grouping, expandable rows, selection with an action bar whose "Create story" button is **disabled** with tooltip "Coming in the next update", the "Mark everything up to here as shared" row menu, paging); Context tab with autosave + switch + backup; project Settings; app Settings (Folders, Agents, Appearance with a working Dark/Light/System toggle stored in localStorage, Storage, About). Stories and Media tabs are empty states. Use design tokens as CSS variables + Tailwind v4 `@theme`. Respect reduced motion. All interactive elements must be keyboard accessible with visible focus.

## Tests (must pass)
- Server unit/integration (vitest), using temp dirs and temp git repos created in the tests (never `~/projects`):
  - git parsing: normal, empty repo, detached HEAD, binary file numstat, merge commit, rebased-away marker
  - discovery depth and skip rules, including a nested repo
  - countSince
  - security middleware: missing cookie → 401, bad Host → 403, bad Origin → 403
  - `resolveSafe` rejects `../` and symlink escapes
  - track a project → `.bip/project.json` exists and `git status --porcelain` is empty
  - moved repo relinks on rescan
  - migrations idempotent
  - context round-trip, commit-context opt-in shows only `.bip/.gitignore` + `.bip/context.md` as untracked
  - backup creates an archive without `renders/`
- One Playwright e2e (`tests/e2e/core.spec.ts`), run against a built server with a temp `BIP_HOME` and a temp folder of 3 generated repos (different commit counts):
  - start → token URL → empty state → Add folder → find 3 repos → track 2 → list sorted by unshared count with correct numbers
  - open one → timeline shows commits grouped by day → mark a mid commit as shared → unshared count updates on the list
  - Context: type notes → reload → persisted
  - toggle light mode → persists across reload

Run `typecheck`, `test`, and `test:e2e` until all are green. Also run `bip doctor`.

## Deliverable
`M1-RESULT.md` at the repo root (the reviewer will delete it before committing), ≤ 50 lines: what was built, test results (counts), deviations from the spec and why, known gaps, how to run. Keep it concise.

## Environment notes (from the M0 spikes)
- Work in the git worktree `/home/justbuster/projects/build-in-public-m1` (branch `m1-foundation`). The storage spike lives at `/home/justbuster/projects/build-in-public/spikes/storage/` (also present in your worktree under `spikes/storage/`).
- The system Node 22.22.1 is built **without** TypeScript stripping (`ERR_NO_TYPESCRIPT`), so `--experimental-strip-types` doesn't work. Use `tsx` for dev/watch and tests, and compile the server with `tsc` (or `tsup`) for `start` and the `bip` bin. Don't install the `node` npm package.
- Playwright 1.64.x matches the cached browsers in `~/.cache/ms-playwright` (chromium-1248), so no browser download is needed. If Chromium won't launch in your sandbox, use `chromiumSandbox: false` in the test config only.
- If the npm/pnpm cache isn't writable, keep caches inside the worktree (gitignored).
