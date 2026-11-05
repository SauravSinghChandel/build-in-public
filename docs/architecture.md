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

Autocomplete is restricted to HOME. Explicitly selected absolute folders are canonicalized and persisted as allowed scan roots, including folders outside HOME. Canonical tracked repositories are additional read roots; only their `.bip` stores are written. Traversal and symlink escapes are rejected; store paths independently reject symlinks. This does not claim protection against a hostile process racing filesystem path replacement. Agent detection invokes versions and the documented local `codex login status`; Claude authentication remains unknown. M1 never invokes an agent model.

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


## M3 Image Studio

`image/` ports the M0 capture, render-origin, overflow and fidelity code. Assets retain M1's canonical SHA-only filenames and add a validated `assets/index.json`; image signatures, decoding, dimensions and a 20 MiB upload limit are checked. API media responses use their actual MIME type, immutable caching and nosniff. Asset and composition thumbnails are generated by Chromium into the XDG cache.

Each image composition is an internal Git repository. Local commit flags supply the BIP author, disable signing and hooks, and leave global Git settings alone. Slot writes are debounced by the client; restore appends a new commit. Immutable revision snapshots are served through random capability URLs on a separate 127.0.0.1 listener. The preview iframe permits scripts without same-origin access and uses a credentialless context. Session cookies are scoped to `/api`; the old root-scoped cookie is cleared on token exchange. The render listener never authenticates with cookies or sets them.

The four bundled presets derive from the spike's responsive launch layout and use local IBM Plex WOFF2 fonts (SIL OFL included beside the presets). BIP injects the trusted slot loader; agent files cannot contain scripts, external resources, event handlers or embedded documents. The renderer blocks requests outside its own origin and checks canvas overflow.

Agent edits run in fresh app-data workspaces, with read-only source copies and no user-repository cwd. Allowed files and sizes, protected metadata, original/copy hashes, CSS source styles, text overlap and pixel fidelity are checked before copy-back and commit. Failed edits preserve the previous revision. The calibrated pixel limit remains 3%; the reference now uses a clean Chromium image at the identical fractional box, avoiding the spike's canvas-vs-CSS resampling error on fine UI detail. The explicit screenshot-edit override bypasses visual checks, never source hashes or overflow checks.

Capture jobs use fresh Chromium contexts without application cookies. Agent step generation returns JSON for review; the UI requires explicit approval before running generated steps. Export checks fidelity again, downloads DPR-2 PNG or quality-90 JPEG, and retains the render as an asset. Posts store image SHA/alt pairs, clear approval on attachment changes, and expose download/copy actions in the publish sheet. All automated agent runs use the fake CLI; live Claude/Codex behavior remains a reviewer smoke test.

## M4 Video Studio

HyperFrames is an exact workspace dependency at **0.9.13**. BIP compositions use
its deterministic CSS/WAAPI adapters and `data-no-timeline`; there is no authored
GSAP dependency. The video validator rejects GSAP/`__timelines`, external URLs,
unsafe resources, symlinks, oversized files and undeclared files before running
HyperFrames `lint --json` against a disposable project with verified source copies.
The BIP video-editor skill overrides HyperFrames's GSAP advice and is supplied
as the final skill content in edit prompts. Render staging also injects a trusted
CSP restricting resource requests to the render origin and disabling connections,
forms, frames and base URLs. Agents never execute the renderer or use a user repo
as their working directory.

`video/` owns CDP capture, timing models, authoring, lint/snapshot/render orchestration
and authenticated routes under `/api/projects/:id/video`. CDP JPEG frames and
injected pointer/click/scroll/navigation events share the browser's epoch clock;
action starts and completions are measured too. FFmpeg assembles the delivered
frames with their durations into H.264 CFR 30. Effective delivered fps and maximum
frame gap include recording boundaries; <12 fps or >500 ms is advisory “Choppy”.
No frame interpolation is claimed. Capture waits for network idle and fonts,
hides native/site cursor overlays and runs only explicitly approved steps in a
fresh context. Imports accept MP4/MOV/WebM up to 500 MiB, probe the container and
video stream, and store FFmpeg scene changes at threshold 0.3 instead of an event log.

Recordings, event/scene JSON, contact sheets and video exports use the existing
content-addressed asset bytes. Metadata can retain several provenance records for
the same SHA (for example, identical renders at different commits or an imported
render); old SHA-keyed indexes remain readable. Media pickers deduplicate by SHA.
Video responses support byte ranges. Events/scenes link from recording provenance.

Video compositions remain internal Git repositories alongside image compositions;
listing filters by type. Four editable files are admitted: composition.json,
index.html, styles.css and optional motion.js. The JSON scene/caption model generates
HTML when slots change; a content hash distinguishes canonical from custom markup.
Caption edits patch custom slots in place; agents must update custom HTML with
metadata changes. BIP refuses to overwrite a custom layout. HTML/CSS changes are retained across renders and restores. Original source hashes and protected identity/source metadata gate agent
copy-back. Source copies are read-only, Codex receives the contact sheet with `-i`,
and Claude is prompted to Read the image. Each revision exposes git diff statistics;
small instructions affecting >3 files or >200 added/deleted lines are flagged.

Clean uses title/outro cards, two captions, a synthetic cursor/ripple, measured click
zooms (.4 s pre-roll, .35 s hold, .65 s return), both-axis centring with edge clamping,
and a 2× ramp on the longest measured scroll segment. Technical adds a terminal
card and an annotated still derived from the source. Image sources use slow pan/zoom, per-still captions
and fades. Imported audio is retained through HyperFrames media-audio clips. Responsive layout preserves footage aspect ratio at all export sizes.

Each revision queues separate contact-sheet and preview jobs through M2's durable
queue. HyperFrames `snapshot` samples twelve times; FFmpeg tiles the PNGs. Preview
is 960×540/30/CRF 30. Final variants are 1920×1080, 1080 square and 1080×1920 at
30 fps/CRF 20, H.264 + AAC, faststart; silence is added only when needed. Outputs
are cached by composition, commit and variant, with decoded frame 150 hashed for
repeat comparisons (the final available frame for videos shorter than 151 frames).
The hash and actual frame index are retained in render provenance; forced repeat
mismatches emit warnings. Videos above 140 seconds show X's duration warning.

Set `chromiumPath` and `videoConfigHome` in BIP config to override the cached
Chromium and writable HyperFrames config directory. `HYPERFRAMES_BROWSER_PATH`
is also respected; otherwise BIP checks Playwright's executable then the browser
cache. HyperFrames receives that path and a writable XDG_CONFIG_HOME explicitly.
Doctor checks the pinned CLI, cached Chromium, FFmpeg and ffprobe. In this sandbox,
run tests with `XDG_CONFIG_HOME=/tmp/bip-m4/config` (create it first); Chromium's
crash handler otherwise encounters the read-only desktop config directory.

The story action launches capture/import/image selection into a full-screen editor.
The timeline is read-only; scene/caption/click markers seek the frame scrubber.
Caption edits create direct revisions. Final render attachments invalidate post
approval and appear as video chips with downloads in the assisted publish sheet.
Automated agent edits use only fixture CLIs; real Claude/Codex smoke is a reviewer step.
