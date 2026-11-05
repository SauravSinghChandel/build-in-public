# Architecture

BIP is one Node.js process that serves a React UI and a JSON API on 127.0.0.1. It stores per-project content as files inside each repository, keeps a small SQLite database for the registry and job queue, and runs external programs (Git, FFmpeg, Chromium via Playwright, HyperFrames, and the `claude`/`codex` CLIs) as child processes. There is no Docker, Redis or hosted backend.

```
┌──────────────────────── Browser (http://127.0.0.1:4310) ────────────────────────┐
│ React 19 + Vite + Tailwind v4 · TanStack Router/Query · Radix · cmdk            │
│ Projects · Overview · Stories · Media · Context · Image/Video Studio · Settings │
└───────────────▲─────────────── REST + SSE (session cookie, Host/Origin checks) ─┘
                │                          ▲ preview iframes (sandboxed)
┌───────────────┴──────────── Server (Node 22, TypeScript, Hono) ─┼───────────────┐
│ projects.ts / git.ts ── git CLI (execFile)                       │               │
│ bip/store.ts ────────── <repo>/.bip/ files (atomic writes, lock)  │               │
│ content.ts ──────────── stories, posts, revisions, approval      │               │
│ jobs/runner.ts ──────── SQLite queue, 2 workers, SSE events      │               │
│   ├─ agents/ ────────── claude -p │ codex exec (isolated workspaces)            │
│   ├─ image/ ─────────── capture, compositions, render ── render origin ─────────┤
│   ├─ video/ ─────────── CDP capture, compositions, HyperFrames + FFmpeg         │
│   └─ publishing/ ────── X / LinkedIn APIs, scheduler, secrets (OS keychain)     │
└──────┬───────────────────────────┬─────────────────────────────┬────────────────┘
       │                           │                             │
  <data>/app.db (SQLite, WAL)   <data>/workspaces, logs,     <repo>/.bip/  per project:
  registry, jobs, agent_runs,   previews, backups,           context, stories, posts,
  platform apps, accounts       secrets fallback             assets, compositions, renders
```

`<data>` is `$BIP_HOME`, or `$XDG_DATA_HOME/build-in-public` (default `~/.local/share/build-in-public`).

## Repository layout

```
apps/server/            Hono API, CLI, job runner, adapters
  migrations/           numbered SQL migrations for app.db
  src/
    cli.ts index.ts     `bip` CLI and server start-up
    app.ts              routes, Host/Origin/session middleware
    config.ts paths.ts  config file, XDG paths, path allowlist
    db.ts               SQLite open + migrations
    projects.ts git.ts  discovery, registry, relinking, git log parsing and caching
    bip/store.ts        the .bip/ store
    content.ts content-routes.ts   stories, posts, agent text tasks, approval, publish marking
    agents/             CLI harness, context bundle, schema adaptation, activity labels
    jobs/runner.ts      durable job queue
    capture/            page element map for capture steps, friendly capture errors
    image/              assets, Image Studio, render origin, validation
    video/              CDP capture, timing model, HTML generation, HyperFrames/FFmpeg
    publishing/         accounts/OAuth, X and LinkedIn clients, publisher + scheduler, secrets
    doctor.ts backup.ts
apps/web/               React UI (routes/, features/, components/)
packages/shared/        Zod schemas and API types shared by server and web
packages/templates/     image presets (minimal, launch, technical, comparison) and video styles (clean, technical)
agent-skills/           BIP's instructions to agents: post-writer, image-composer, video-editor
tests/                  Playwright e2e specs, fake agent CLI and fixtures, X/LinkedIn mock
spikes/                 M0 proof-of-concept code and results (reference only)
```

TypeScript is strict everywhere. Production runs the compiled JavaScript in `apps/server/dist`; development uses `tsx watch`, because Ubuntu's Node 22 can't strip TypeScript types.

## CLI

`apps/server/dist/cli.js` is the `bip` binary (after `pnpm build`):

| Command | What it does |
|---|---|
| `bip start` (default) | Writes the default config if missing, rescans folders, starts the scheduler, serves the app and opens the session URL (unless `BIP_NO_OPEN` is set). |
| `bip doctor` | Checks Node ≥ 22, git, ffmpeg, ffprobe, Playwright Chromium, HyperFrames 0.9.13 and its Chromium, the agents, a writable data directory, a free port, and Docker contexts of tracked repos. Exits 1 if a required check fails; agent checks are advisory. |
| `bip backup --project <id>` / `--all` | Writes `.bip/` (without `renders/` and the lock) to `<data>/backups/<project-id>/<timestamp>-<id>.tar.gz` using system `tar`. |
| `bip publish-due` | Runs one scheduler pass and exits; does nothing if the app is already running. See [scheduling.md](scheduling.md). |

Root scripts: `pnpm start` (build + `bip start`), `pnpm dev` (API on 4310 and Vite on 5173), `pnpm run doctor`, `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm typecheck`.

## Configuration

`config.json` lives at `$XDG_CONFIG_HOME/build-in-public/config.json` (default `~/.config/build-in-public/config.json`), or at `$BIP_HOME/config.json` when `BIP_HOME` is set. Unknown keys are rejected.

| Key | Default | Meaning |
|---|---|---|
| `port` | `4310` | Server port (`BIP_PORT` overrides) |
| `claudeBin`, `codexBin` | `claude`, `codex` | Agent binaries (`BIP_CLAUDE_BIN`, `BIP_CODEX_BIN` override) |
| `chromiumPath` | Playwright's Chromium | Browser used by HyperFrames (`HYPERFRAMES_BROWSER_PATH` overrides) |
| `videoConfigHome` | `<data>/hyperframes-config` | Writable config directory passed to HyperFrames |

Other environment variables: `BIP_HOME`, `BIP_NO_OPEN`, `BIP_SECRET_STORE=keychain|file`, `BIP_CAPTURE_GPU=0` (force software rendering for capture), `BIP_X_API_BASE`, `BIP_X_AUTH_BASE`, `BIP_LINKEDIN_API_BASE`, `BIP_LINKEDIN_AUTH_BASE`, `BIP_LINKEDIN_VERSION` (default `202510`). Development and test only: `BIP_DEV_NO_AUTH` (with `NODE_ENV=development`), `BIP_TEST_CLOCK_OFFSET_MS`, `BIP_SCHEDULER_INTERVAL_MS`, `BIP_PUBLISH_BACKOFF_MS`, `BIP_X_CHUNK_BYTES`, `BIP_FAKE_MODE` (fake agent). UI appearance is stored in the browser (`bip-appearance`).

## Data layout

### Per project: `<repo>/.bip/`

```
<repo>/.bip/
├── project.json            id, name, root commit, last shared commit + date, settings
├── context.md              shareable notes (the only file that can be committed, opt-in)
├── private.md              "never mention" notes, never committed
├── auto-summary.md         agent summary, tagged with the HEAD it describes
├── .gitignore              `*`, `!.gitignore`, `!context.md`
├── .lock                   PID lock: one writer per project
├── stories/<story-id>/
│   ├── story.json          title, brief, angle, status, selected commits / range
│   └── posts/<post-id>/
│       ├── post.json       platform, kind, status, current/approved revision, media, schedule, external ids, URL
│       └── revisions.jsonl append-only revision history
├── assets/<sha256>         content-addressed bytes (screenshots, recordings, uploads, exports)
├── assets/index.json       sha → kind, MIME type, size, provenance
├── compositions/<id>/      one internal Git repository per image or video (revision = commit)
├── renders/<id>/           <commit>[-<size>].png|jpg, <commit>-<variant>.mp4
└── .backup/                copies made before a schema migration
```

On first write BIP appends `.bip/` to `.git/info/exclude` (found with `git rev-parse --git-common-dir`, so worktrees work). The `.gitignore` inside `.bip/` keeps private files ignored even if another worktree removes that shared exclude line. Opting a project into "commit context" removes the exclude line so only `context.md` can be committed. Worktrees share `info/exclude`, so this opt-in applies to the whole repository.

`git clean -fdx`, deleting the repository or re-cloning it removes `.bip/`. The UI warns about this, and `bip backup` / "Back up now" make snapshots.

### App data: `<data>/`

```
<data>/
├── app.db                  SQLite (WAL): tracked_dirs, projects, jobs, agent_runs, platform_apps, accounts
├── config.json             only when BIP_HOME is set
├── workspaces/<job-id>/    agent working directories
├── logs/agents/<run>.jsonl raw agent output
├── previews/               immutable composition snapshots served by the render origin
├── hyperframes-config/     HyperFrames' writable config directory
├── backups/<project-id>/   .tar.gz snapshots of .bip/
└── secrets.enc, secrets.key  only when the OS keychain is unavailable
```

Thumbnails are cached in `$XDG_CACHE_HOME/build-in-public/thumbs` (default `~/.cache/build-in-public/thumbs`) and are safe to delete.

### Store guarantees

`bip/store.ts` validates every file with Zod on read, writes atomically (temp file in the same directory, fsync, rename), and serialises writes per resource with async mutexes. A `.lock` file with the owner's PID allows one writer per project; a second BIP instance gets a read-only view. Each JSON file has a `schemaVersion` and is migrated on read after a copy goes to `.bip/.backup/`. `app.db` uses numbered SQL migrations with `PRAGMA user_version`, run in a transaction after the database is checkpointed and copied.

Limits: a reused PID or malformed lock fails closed (read-only); directory fsync is not a power-loss guarantee; a revision and the post's pointer to it are separate writes, not a transaction; backups are snapshots, not a transaction.

## Projects and Git

Discovery walks the folders you add, to a configurable depth (default 2), skipping generated and hidden directories, and stops at each repository. A folder counts as a repository only if `git rev-parse --show-toplevel` (with `GIT_CEILING_DIRECTORIES`) returns that folder; broken ones are listed as invalid with a fix hint and can't be tracked. Git runs with `execFile`, a 10-second timeout and bounded output; logs are parsed from record/field-separated output with numstat. Results are cached by repository path and HEAD; the projects list is served from memory first (`?cached=1`) and refreshed in the background.

"Since last post" is `git log <lastSharedCommit>..HEAD`. If the marker is no longer an ancestor (history rewritten or pruned), counts fall back to commits after the saved marker date and the UI reports the marker as lost. The first published post of a story advances the marker, under the store lock and only if the new commit descends from the old one.

Moved repositories are relinked on rescan by `.bip/project.json` id, then by root commit plus origin URL. Missing paths keep their registry row with status `missing`.

## Job runner

Long work runs as jobs (`jobs/runner.ts`), stored in the `jobs` table: agent tasks (`story.angles`, `post.draft`, `post.edit`, `project.summary`, `image.steps`, `image.alt`, `image.edit`, `video.steps`, `video.captions`, `video.edit`), capture (`image.capture`, `video.capture`), rendering (`video.contact`, `video.preview`, `video.final`) and `publish`.

- At most two jobs run at once, first in first out, and never two with the same resource key (for example one post or one composition).
- Progress, text and tool activity go to the browser over Server-Sent Events (`/api/events`) with a 300-event replay buffer. On reconnect the client also refetches the persisted jobs.
- Cancel aborts the job; agent processes get SIGINT, then SIGTERM, then SIGKILL.
- On start-up, jobs left `running` become `interrupted`. Resume reuses the stored agent session id for that job; new edits always start a fresh session.
- Shutdown closes SSE connections, waits for cancellations and releases store locks.

## Agents

Agents run as child processes in fresh workspaces under `<data>/workspaces/`, never inside a repository, with read-only tools unless the task edits a composition copy. Writing tasks get a redacted context bundle instead of repository access. See [agents.md](agents.md) for the flags, the context bundle and the provider interface.

## Posts

Revisions are appended to `revisions.jsonl` and include the agent's highlights and "claims to verify". Manual edits within 60 seconds fold into one visible revision; restore appends a new revision. Approval binds to the current revision and is refused while secret matches, unchecked claims or unacknowledged private-term warnings remain. Any change clears approval. Assisted publishing copies text, offers media downloads and opens X's intent URL or LinkedIn's share URL; recording a published URL requires an approved post and a matching HTTPS URL for the platform.

## Image Studio and the render origin

- Screenshots come from uploads (PNG, JPEG or WebP up to 20 MiB) or from capture: a fresh Chromium context without BIP cookies loads the URL, runs approved steps (click, type, scroll, hover, wait, press, pause, scrollTo) and takes a viewport, full-page or element screenshot. Agent-written steps use only selectors from an element map extracted from the live page, and each step is dry-run before you approve it.
- A composition is a directory (`composition.json` with canvas size, preset and slots, plus `index.html` and `styles.css`) copied from a preset in `packages/templates/image/`, kept as an internal Git repository. Slot edits and agent edits are commits; restore adds a commit. Commits use a fixed BIP author and disable hooks and signing without touching your Git config.
- Revision snapshots are copied to `<data>/previews/` and served by the **render origin**: a separate HTTP listener on a random 127.0.0.1 port, addressed by random capability paths, with its own CSP and no cookies. The UI previews them in a sandboxed, credentialless iframe. Rendering uses Playwright at device scale factor 2 with all requests outside the render origin blocked, then checks canvas overflow and screenshot fidelity.
- Export produces PNG or quality-90 JPEG, stores it as an asset and keeps the render under `renders/`.

## Video Studio

- **Capture:** Chromium's DevTools screencast records JPEG frames while BIP injects pointer, click, scroll and navigation listeners on the same clock, and measures when each action starts and finishes. FFmpeg assembles the frames into H.264 at 30 fps. Capture waits for network idle and fonts, hides cursors, and runs only approved steps. If the effective frame rate is below 12 fps or a frame gap exceeds 500 ms, the recording is flagged "Choppy". When a hardware WebGL renderer is available, capture uses `--use-angle=gl --ignore-gpu-blocklist --enable-gpu-rasterization`; `BIP_CAPTURE_GPU=0` forces Chromium's defaults.
- **Import:** MP4, MOV or WebM up to 500 MiB, probed with `ffprobe`; FFmpeg scene detection (threshold 0.3) stands in for the event log.
- **Compose:** a composition has `composition.json` (scenes, captions, style), generated `index.html`, `styles.css` and an optional `motion.js`, in an internal Git repository. The Clean and Technical styles use CSS and Web Animations only (no GSAP): title and outro cards, captions, a synthetic cursor with click ripples, zooms timed from measured clicks, and a 2× speed-up on the longest scroll. Bundled IBM Plex fonts are staged next to every render.
- **Check and render:** HyperFrames 0.9.13 runs `lint --json`, `snapshot` (12 frames, tiled into a contact sheet with FFmpeg) and `render`. Each revision queues a contact sheet and a 960×540 preview; final renders are 1920×1080, 1080×1080 or 1080×1920 at 30 fps, H.264 + AAC with faststart. Renders are cached by composition, commit and variant. HyperFrames always runs with `HYPERFRAMES_NO_TELEMETRY=1`, its browser path, and a writable `XDG_CONFIG_HOME`.
- Agents receive the contact sheet so they can see the frames; small instructions that change more than 3 files or 200 lines are flagged.

## Publishing and scheduling

Direct publishing is optional; without connected accounts the assisted flow is the only one.

- **Accounts:** you register your own X and LinkedIn developer apps with the redirect URI `http://127.0.0.1:<port>/oauth/<platform>/callback`. X uses OAuth 2.0 with PKCE and scopes `tweet.read tweet.write users.read media.write offline.access`; LinkedIn uses the authorization code flow with `openid profile w_member_social` and needs a client secret. One account per platform. LinkedIn tokens last about 60 days; the UI warns 7 days before expiry.
- **Secrets:** OS keychain via `@napi-rs/keyring`, or an encrypted fallback file (see [security.md](security.md)). SQLite stores metadata only.
- **Publish jobs** (resource key `post:<id>`) upload media first, then create the post or each thread part (X threads reply to the previous part). Approval is re-checked at the start and before every create call. Returned ids are saved immediately so retries continue where they stopped. Rate limits (429) wait for the reset header with backoff; uploads and status polls also retry 5xx, timeouts and network errors (up to 3 retries). Create-post calls are not retried automatically after an ambiguous failure; the post is marked "May have posted".
- **Scheduling:** an in-process scheduler checks every 30 seconds and enqueues due posts up to 2 minutes late; later ones are shown as Overdue. `bip publish-due` does one pass for use from a systemd timer. See [scheduling.md](scheduling.md).

## Tests

Unit and integration tests (Vitest, `apps/**/*.test.ts`) use disposable repositories in the OS temp directory. End-to-end tests (Playwright, `tests/e2e/`) start the compiled server with a temporary `HOME` and `BIP_HOME`, use the fake agent CLI in `tests/fixtures/agents/` and the X/LinkedIn mock in `tests/mocks/platforms.ts`, and never touch your own projects. See [CONTRIBUTING.md](../CONTRIBUTING.md).
