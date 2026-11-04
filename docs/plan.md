# Build in Public — Plan

## Context

Saurav wants a local-first, open-source dev tool that turns recent Git work across many repos into ready-to-post X/LinkedIn content (text, polished images, edited demo videos), using the Claude Code and Codex subscriptions he already pays for. Nothing exists yet: `~/projects/build-in-public` is an empty directory, not a Git repo. This plan covers Git setup (blocked by Plan Mode until approved), research findings, architecture, data model, UI, milestones, risks, and open decisions.

---

## 0. Git setup (run after approval — Plan Mode blocks it)

Findings:
- `~/projects/build-in-public` is empty and **not** a Git repo.
- Remote `SauravSinghChandel/build-in-public` exists, is **private**, and is **empty** (no commits, no branches). No reconciliation needed.
- **No global `user.name` / `user.email` is configured**, and `init.defaultBranch` is unset (would default to `master`).

Commands:
```bash
cd ~/projects/build-in-public
git init -b main
git remote add origin git@github.com:SauravSinghChandel/build-in-public.git
git remote -v                         # verify
git config user.name  "Saurav Singh Chandel"     # repo-local only
git config user.email "sauravca527@gmail.com"
git ls-remote origin                  # re-verify remote still empty before first push
```
No commit or push until the plan is approved. First push later: `git push -u origin main`. Repo is private today; flip to public at the M6 release.

---

## A. Product summary

**What:** a local web app (`pnpm start` → `http://127.0.0.1:4310`) that watches your project folders, knows what each project is and what changed since you last posted, and helps you produce and publish posts, images, and videos about that work.

**Who:** solo developers who build in public across several repos.

**Core loop (the thing that must feel great):**
1. Open app → Projects list shows "N commits since last post" per project.
2. Open a project → see the unshared work grouped into candidate "moments".
3. Click "Create story" on a moment → X + LinkedIn drafts appear, grounded in the commits and project context.
4. Optionally attach a polished screenshot image or short demo video made in the same story.
5. Approve → copy/open composer (MVP) or publish via API (later) → paste back URL → project's "last shared" marker moves forward.

---

## B. Architecture

```
┌──────────────────────────── Browser (127.0.0.1) ─────────────────────────────┐
│ React + Vite + Tailwind + shadcn/ui                                          │
│ Projects · Project workspace · Story editor · Image/Video studio · Settings  │
└───────────────▲──────────────── REST + SSE (session token, Origin check) ────┘
                │
┌───────────────┴──────────── Local server (Node 22, TypeScript, Hono) ────────┐
│ Projects/Git svc ── git CLI (execFile, no shell)                             │
│ Context svc ────── context.md / private.md / auto-summary                    │
│ Content svc ────── stories, posts, revisions, assets, compositions           │
│ Job runner ─────── SQLite-backed queue, per-resource locks, SSE progress     │
│   ├─ Agent adapters: ClaudeCodeCLI (`claude -p`) │ CodexCLI (`codex exec`)    │
│   ├─ Capture: Playwright (screenshots, scripted demo recording + event log)  │
│   ├─ Render image: Playwright screenshot of HTML composition (sandbox origin)│
│   ├─ Render video: HyperFrames or Remotion CLI (picked after PoC-4)          │
│   └─ Publish: Assisted (copy/intent URLs) │ X API │ LinkedIn API (later)      │
│ Secrets ────────── OS keychain (libsecret) via @napi-rs/keyring              │
└──────┬──────────────────────────┬─────────────────────────────┬──────────────┘
       │                          │                             │
  app.db (SQLite, WAL)     ~/.local/share/build-in-public   <repo>/.bip/  (per project:
  registry, jobs,          workspaces/ logs/ cache          context, stories, posts,
  agent runs, accounts                                       assets, compositions, renders;
                                                             hidden via .git/info/exclude)
```

One process, no Docker, no Redis/Postgres. Agents run as child processes of the server in isolated workspaces (see Security).

---

## C. Technology decisions

| Area | Recommendation | Why | Alternatives considered | Trade-offs |
|---|---|---|---|---|
| Layout | pnpm workspace: `apps/web`, `apps/server`, `packages/shared` | Shared zod schemas/types between web and server; clean boundaries; still one `pnpm start` | Single package; Turborepo/Nx | pnpm needs corepack (system npm here is 9.2) |
| Frontend | React + Vite + Tailwind v4 + shadcn/ui + TanStack Query + TanStack Router | Your preference; shadcn gives owned, restylable primitives (good for a non-generic look) | Svelte, Next.js | Next adds SSR/server we don't need |
| Server | Node 22 + Hono | Tiny, typed, fast, easy SSE | Fastify, Express | — |
| Storage (decided) | **Per-project content in `<repo>/.bip/`** as JSON + Markdown + media files; **small central SQLite `app.db`** only for the project registry, job queue, agent runs, and account metadata | Your choice: data travels with the repo and is human-readable. The job queue needs transactional updates across restarts, which is the one place SQLite earns its keep | Central-only SQLite; hybrid | `git clean -fdx`, re-cloning, or deleting a repo wipes its `.bip/` → built-in `bip backup`; cross-project Content view reads files on demand (fine at ~20 projects) |
| Migrations | Each `.bip` JSON file carries `schemaVersion`; zod-validated, migrated on read with a `.bip/.backup/` copy first. `app.db` uses numbered SQL + `PRAGMA user_version` | Simple, no ORM | Drizzle Kit | — |
| Git | `git` CLI via `execFile` with parsed porcelain/format output | Matches your preference; no native deps | simple-git, isomorphic-git | Must parse output carefully |
| Agents | Spawn user-installed `claude` and `codex` CLIs in non-interactive mode | Officially supported; uses each user's own login; no credential handling by us | Agent SDKs with API keys (supported as optional "API mode" later) | CLI flag drift → adapter tests + version check in `bip doctor` |
| Browser automation | Playwright (Chromium) | Screenshots, scripted demos, and the image renderer | Puppeteer | Chromium download (~150 MB) at setup |
| Video engine (**decide after PoC-4**) | Bake-off: **HyperFrames** (Apache-2.0, ~79k★, very active, HTML compositions, official Claude Code + Codex skills, CLI lint/frame-inspect/render) vs **Remotion** (React, mature, agent skills; free for individuals and ≤3-employee companies, source-available, company license above that) | HyperFrames is the front-runner: license fits an MIT project and it shares HTML tech with Image Studio | Motion Canvas / Revideo (MIT, smaller and slower-moving) | Choosing Remotion means documenting its license terms for BIP users at companies |
| Image rendering | HTML/CSS composition rendered by Playwright at 2× DPR | Unlimited creative freedom for agents, pixel-exact screenshots, reusable as a video scene | Satori (no full CSS), Canvas (hard for agents), Fabric/Konva (needs custom editor) | Chromium per render (~0.5–1 s, fine) |
| Media processing | System FFmpeg (already 8.0.1 here) | Probing, thumbnails, transcoding, scene detection | bundled ffmpeg-static | Users must install FFmpeg; `doctor` checks it |
| Secrets | OS keychain (`@napi-rs/keyring` → libsecret on Linux), fallback 0600 file with warning | Standard, cross-platform later | plaintext config | Headless Linux without keyring → fallback path |
| License (ours) | MIT (Q6) | Simple, common for dev tools | Apache-2.0 | — |

**Not using / only learning from:** Postiz (AGPL, needs Postgres+Redis+Temporal — too heavy to embed; optional adapter later if you already run it), Recordly (AGPL — ideas only, no code), OpenScreen (MIT but **archived** Oct 2026), Cap (mixed/AGPL desktop). Never copy AGPL code into this repo.

---

## D. Repository and data layout

**App source (this repo):**
```
build-in-public/
├── apps/
│   ├── web/                 # React UI
│   └── server/              # Hono API, job runner, adapters
│       └── src/{projects,git,context,content,jobs,agents,capture,render,publish,security,db}
├── packages/
│   ├── shared/              # zod schemas, API types
│   └── templates/
│       ├── image/           # preset HTML templates (minimal, launch, technical, comparison)
│       └── video/           # HyperFrames starter compositions per style
├── agent-skills/            # BIP's own instructions for agents (post-writer, image-composer, video-editor)
├── scripts/                 # setup.ts, doctor.ts
├── docs/                    # architecture, security, contributing, licenses
├── LICENSE  README.md  CONTRIBUTING.md
```

**Per-project data — `<repo>/.bip/` (decided):**
```
<repo>/.bip/
├── project.json                 # id, root_commit, last_shared_commit, project settings, schemaVersion
├── context.md                   # your shareable notes (the only file that can ever be committed, opt-in)
├── private.md                   # "never share" notes — never committable
├── auto-summary.md              # agent-generated, tagged with the HEAD sha it describes
├── stories/<story-id>/
│   ├── story.json               # title, status, brief, commit range
│   └── posts/<post-id>/
│       ├── post.json            # platform, kind, status, approval, published_url, links
│       └── revisions.jsonl      # append-only revision history
├── assets/<sha256>.<ext>        # immutable, content-addressed (screenshots, recordings, uploads)
├── compositions/<comp-id>/      # each one is a tiny internal git repo (revision = commit)
│   └── composition.json  index.html  styles.css …
├── renders/<comp-id>/<rev>.png|.mp4
├── .backup/                     # pre-migration copies
└── .lock                        # pid lock: one BIP instance per project
```
Git interaction (decided): on first write BIP appends `.bip/` to the repo's `.git/info/exclude` (resolved via `git rev-parse --git-common-dir`, so worktrees work). That file is local and never committed, so `git status` stays clean. Opting a project into "commit context" removes the exclude line and writes `.bip/.gitignore` = `*`, `!.gitignore`, `!context.md`.

**App-level data (XDG, overridable with `BIP_HOME`):**
```
~/.config/build-in-public/config.json      # app settings, ports, appearance
~/.local/share/build-in-public/
├── app.db                                 # SQLite: tracked_dirs, project registry, jobs, agent_runs, accounts
├── workspaces/<job-id>/                   # agent scratch dirs (cleaned after success)
├── logs/agents/<run-id>.jsonl             # raw agent event streams
└── backups/<project-id>/<date>.tar.zst    # `bip backup` snapshots of .bip/ (minus renders)
~/.cache/build-in-public/                  # thumbnails, preview frames (safe to delete)
```

---

## E. Storage evaluation (your 10 questions)

Decision: **in-repo `.bip/` for all per-project content**, hidden from git by default (your answers). My earlier recommendation was central storage; the in-repo choice works with these guards:

1. **Metadata in each repo:** yes, in `.bip/`. Upside: data moves with the repo and is easy to inspect.
2. **Central dir:** kept only for app-level state (registry, job queue, agent logs, account metadata, backups).
3. **Hybrid:** effectively yes (above), but all content lives in the repo.
4. **JSON + Markdown enough?** For per-project content, yes, with discipline: zod validation on read, atomic writes (temp file + fsync + rename), append-only `revisions.jsonl`, and one per-project async mutex in the single server process.
5. **SQLite:** only for `app.db` (job queue + registry need transactional updates across crashes). It's small and rebuildable except for job history.
6. **Large media:** content-addressed under `.bip/assets/`; renders are regenerable, so "Clean renders" frees space. Settings shows `.bip/` size per project. **Caveat:** `.git/info/exclude` doesn't stop Docker build contexts (`COPY . .`). `bip doctor` warns when a repo has a Dockerfile and no `.dockerignore` entry.
7. **Migrations:** `schemaVersion` per JSON file, lazy migrate-on-read with a copy to `.bip/.backup/`.
8. **Git interference:** `.git/info/exclude` keeps `git status` clean; ripgrep and most editors respect it too. **Data-loss caveat:** `git clean -fdx`, re-cloning, or deleting the repo removes `.bip/`. Mitigations: a one-time warning, `bip backup` (manual + optional auto-backup on publish), and backups excluding renders.
9. **Git-track context:** opt-in per project; only `context.md` can be committed.
10. **Moved/renamed/deleted repos:** data travels with the repo. The registry matches by `.bip/project.json` id → root commit SHA → remote URL. A missing path gets status `missing`; rescans re-link automatically. "Remove project" untracks it, and deleting `.bip/` is a separate, confirmed action.

Two BIP instances (or a worktree sharing a project) can't corrupt data: `.bip/.lock` holds the pid, and a second writer gets a read-only view.

**Scanning:** manual "Rescan" + on app start + when the Projects page gains focus (debounced). Depth-limited (default 2) `.git` discovery, skipping `node_modules`, `.venv`, etc. Git activity per project is fetched lazily and cached by HEAD SHA. No inotify watchers (inotify limits, background noise, little benefit).

---

## F. Information architecture and UI

**Global nav (left rail, collapsible) — 3 items:**
1. **Projects** (home)
2. **Content** — cross-project library: stories, drafts, ready-to-post, published; filter by project/platform/status. A "Scheduled" view appears here once scheduling exists (replaces a separate Calendar until M5).
3. **Settings** — agents, accounts, folders, appearance, storage.

Plus `⌘K` command palette (new story, jump to project, rescan, capture screenshot).

**Project workspace tabs (fewer than proposed):**
- **Overview** — unshared activity since last post (grouped commits = candidate moments), active stories, latest published, quick actions.
- **Stories** — the content unit (see data model). A story holds its X post(s), LinkedIn post(s), images, videos, and follow-ups. History = this list filtered to published, plus per-item revision history.
- **Media** — all assets for the project (screenshots, recordings, rendered images/videos). "New image", "New video", "Capture" live here.
- **Context** — editable `context.md`, `private.md`, auto-summary (regenerate), "commit context.md to repo" toggle, `.bip/` size + backup.
- **Settings** — project-specific agent/tone defaults, scan options, relink path.

Image Studio and Video Studio are **full-screen editors** opened from a story or the Media tab, not tabs. That keeps every image/video attached to a project (and usually a story) instead of floating around.

**Key screens (MVP marked ★):**
- ★ **Projects dashboard** — dense list rows (not cards): name · branch · "12 commits since last post" · last post date · drafts count. Sort by "most unshared work". Empty state = "Add a folder".
- ★ **Project overview** — left: activity timeline grouped by day with commit subjects and diffstats; checkbox-select commits → "Create story from selection". Right: active stories, last published post.
- ★ **Story editor** — top: story title + brief (what changed, why it matters; editable, grounded in selected commits). Below: side-by-side X and LinkedIn drafts (each independently editable, char counter, thread splitting for X). Under each draft: action bar (Regenerate · Shorten · Expand · Tone ▾ · Adapt from other platform · Follow-up) + free-form instruction box. Revision timeline per draft with restore. Right sidebar: attached media + "Add image/video".
- ★ **Publish sheet (assisted)** — final preview, secret/private-note check results, "Copy text", "Download media", "Open in X/LinkedIn", then "Paste published URL" → marks published.
- **Image Studio** (M3) — center canvas preview; left: source screenshot + preset + aspect ratio (1:1, 16:9, 4:5, 1200×675 X, 1200×627 LI); right: editable slots (headline, subhead, background, frame, annotations) + chat box for free-form edits; bottom: revision strip.
- **Video Studio** (M4) — preview player; timeline with scenes (read-only visualization of composition); chat for edits ("intro too slow…"); revision list with renders; frame contact sheet for quick review.
- **Content (global)** (M2 basic list, richer later).
- **Calendar** (M5, only if scheduling proves useful).
- ★ **Settings** — folders, agent detection/status + routing, appearance; accounts (M5).

**Visual direction:** near-black neutral background (not pure #000), 1px low-contrast borders, one accent color, Inter/Geist + a mono font for SHAs/paths, 8-pt spacing, 120–180 ms ease-out transitions, no gradients except inside generated media. Detailed design pass with the `frontend-design` skill at M1 start.

---

## G. Data model (first cut)

**`<repo>/.bip/` files (zod schemas in `packages/shared`):**
```ts
project.json   { schemaVersion, id, name, rootCommit, remoteUrl?, lastSharedCommit?, commitContext: bool,
                 settings: { tone?, audience?, defaultPlatforms[] } }
story.json     { schemaVersion, id, title, brief, status: idea|drafting|ready|published|archived,
                 commitRange?: {from, to}, compositionIds[], createdAt, updatedAt }
post.json      { schemaVersion, id, storyId, platform: x|linkedin, kind: post|thread|follow_up,
                 derivedFromPostId?, replyToPostId?, currentRevisionId, approvedRevisionId?,
                 status: draft|approved|scheduled|publishing|published|failed,
                 media: [{assetSha, alt?}], scheduledAt?, publishedAt?, publishedUrl?, externalId?, error? }
revisions.jsonl  { id, parts: string[] /* 1 for a post, n for an X thread */, instruction?,
                   author: user|agent, agentRunId?, createdAt }      // one line per revision
composition.json { schemaVersion, id, type: image|video, title, preset, width, height, fps?,
                   slots: {...}, sources: [assetSha], engine?: hyperframes|remotion }
                 // revisions = commits in the composition's internal git repo;
                 // render outputs keyed by commit sha in renders/<comp-id>/
assets/<sha>.<ext> + assets/index.json { sha → kind, mime, w, h, durationMs, provenance }
```

**`app.db` (SQLite):**
```
tracked_dirs(id, path, depth, last_scanned_at)
projects(id, path, root_commit, remote_url, status[active|missing|archived], tracked_dir_id?, added_at)
jobs(id, type[agent|capture|render_image|render_video|publish|scan],
     status[queued|running|succeeded|failed|interrupted|cancelled], project_id?, resource_key,
     payload_json, result_json, error, progress, attempts, created_at, started_at, finished_at)
agent_runs(id, job_id, provider[claude|codex], model?, session_id?, cwd, log_path, cost_usd?, exit_code)
accounts(id, platform, handle, keychain_ref, scopes, expires_at)          -- M5
```
- Relationships are explicit ids (story → posts/compositions; post → derivedFrom/replyTo; post → media by sha). No generic graph table, and no duplicated files: assets are referenced by hash.
- "Changes since last share" = `git log <last_shared_commit>..HEAD`; marking a post published (with a story commit range) advances `last_shared_commit`.
- Approval binds to a revision: publishing requires `approved_revision_id == current_revision_id`.

---

## H. AI agent integration

**How we invoke (documented, non-interactive):**
- **Claude Code:** `claude -p --output-format stream-json --verbose --json-schema <schema> --permission-mode dontAsk --allowedTools "<explicit list>" --add-dir <dir> --strict-mcp-config --setting-sources user --resume <id>` (all flags present in installed v2.1.318).
- **Codex:** `codex exec --json --output-schema <file> -s read-only|workspace-write -C <workspace> --add-dir <dir> --skip-git-repo-check -i <image>` and `codex exec resume <id>` (v0.166.0).

**Auth (verified against current docs):**
- Anthropic's legal page explicitly allows *"an end user … signing in to the unmodified Claude Code binary with their own Claude subscription"*, and forbids third-party apps from offering Claude.ai login or handling Claude credentials. So BIP **never** touches tokens: each user runs `claude` / `codex login` themselves; BIP only spawns the binaries they installed. `--bare` is avoided by default because it ignores subscription login.
- Since 15 Jun 2026, `claude -p`/Agent SDK usage on a subscription draws from a separate monthly **Agent SDK credit**, not interactive limits; overflow needs "extra usage" enabled. BIP surfaces `total_cost_usd` per run and supports `--max-budget-usd`.
- Codex docs call ChatGPT-login automation an "advanced option for trusted runners"; a personal machine qualifies. `CODEX_API_KEY` also works.
- Optional "API key mode" for each provider later (Anthropic/OpenAI keys in keychain).

**Adapter interface (server):**
```ts
interface AgentProvider {
  id: 'claude' | 'codex';
  detect(): Promise<{installed: boolean; version?: string; authed?: boolean}>;
  run(req: {task: TaskType; prompt: string; workspace: string; readDirs: string[];
            writeDirs: string[]; outputSchema?: JSONSchema; images?: string[];
            resumeSessionId?: string; budgetUsd?: number; signal: AbortSignal}):
      AsyncIterable<AgentEvent>;   // normalized: text | tool | progress | result | error
}
```
**Routing (decided: ask per task):** every agent action (Generate, Rewrite, Compose image, Edit video, …) shows a small Claude/Codex picker next to the button. No global routing defaults. As a convenience (my assumption), the picker preselects whichever agent you last used for that task type in that project. Agents that aren't installed or logged in are shown disabled, with a fix hint.

**Reuse instead of custom code:** both video candidates ship official agent skills (HyperFrames: Claude Code plugin + Codex skills; Remotion: `remotion-dev/skills`). We install the winner's skills into the agent workspace rather than writing our own video DSL. Playwright MCP is available for agent-driven capture if needed, but BIP drives Playwright directly for determinism.

**Long tasks:** every agent run is a job; stream events over SSE; raw JSONL logs kept; cancel = SIGINT then SIGTERM; on server restart, `running` → `interrupted` with a "Resume" button using the stored session ID.

---

## I. Image Studio strategy

- A composition is an HTML/CSS directory (`composition.json` declares canvas size, preset, and editable **slots**: headline, subhead, background, frame, annotations, branding). The UI edits slots directly; agents can edit any file for free-form changes.
- Screenshots are referenced by content hash from the read-only asset store; agents cannot write there.
- **Fidelity guard:** lint rejects CSS filters/blend modes/text overlays on the screenshot element unless the user enables "allow edits to screenshot"; after render, a pixel-diff of the screenshot region vs. the source (for unrotated placements) flags accidental changes.
- Rendering: served from a separate sandbox origin/port, network blocked except local assets, Playwright screenshot at 2× DPR → PNG.
- Modes: (1) import screenshot → preset → done; (2) URL + steps → Playwright capture (full page, element, or clipped region); (3) free-form agent composition; (4) edit any uploaded image the same way. Before/after = a two-slot preset.
- Generative AI images (backgrounds only) are **deferred** and would need a separately configured provider/API key; subscriptions are not assumed to include it.

## J. Video Studio strategy

1. **Capture:** BIP drives Playwright through a scripted demo (steps the agent writes from your description, shown to you before running). Recording via CDP screencast/Playwright video at fixed viewport, plus an **event log** (cursor path, clicks, scrolls, navigation, timestamps). Knowing exact click times/positions is what makes automatic smooth zooms, cursor highlights, and speed ramps possible.
2. **Compose:** agent writes a composition (HyperFrames HTML or Remotion React, per PoC-4) from a style starter (Clean/Energetic/Cinematic/Technical) + the recording + event log + Image Studio stills.
3. **Check:** engine lint/typecheck → render a contact sheet of key frames → agent reviews the frames (images in, not guesswork) → fixes → low-res preview render.
4. **Iterate:** each chat instruction = one agent turn = one commit in the composition's internal git repo. Revert/compare any revision; original recordings never change.
5. **Final render:** 1080p MP4 (X/LinkedIn-safe: H.264, AAC, ≤ 2:20 for X), plus optional square/vertical variants.
- Import existing video: probe with FFmpeg, scene-detect, contact sheet → agent proposes edit.
- Terminal/"Technical" demos: VHS or asciinema-style capture later.
- Desktop (non-browser) recording: deferred; import covers it.

## K. Publishing strategy

- **MVP (assisted):** copy text, download media, open X intent (`x.com/intent/post?text=`) or LinkedIn share URL, then paste the published URL back. Zero API cost, no app review, nothing can post without you clicking.
- **Later (direct API, your own developer apps):**
  - X: pay-per-use since Feb 2026 (~$0.015 per post; posts containing a URL reportedly ~$0.20); OAuth 2.0 PKCE; media upload endpoint.
  - LinkedIn: "Share on LinkedIn" product, `w_member_social`, Posts API with person URN; tokens ~60 days, plan for re-auth.
  - Scheduling only fires while BIP is running; optional systemd user timer runs `bip publish-due`.
- Hard rule: publish requires an approval bound to the exact revision; no auto-publish anywhere.
- No browser automation of X/LinkedIn.

---

## L. Security model (practical, local tool)

- **Server:** bind 127.0.0.1 only; random session token (cookie + header) generated at startup; reject requests whose `Host`/`Origin` isn't the app's (DNS-rebinding/CSRF protection).
- **Filesystem:** server-side path allowlist = tracked repos (read), each repo's `.bip/` + BIP app data dir (read/write). All paths realpath-checked, and symlinks inside `.bip/` pointing outside are rejected. Agents get `.bip/assets/` read-only and write only to their workspace or composition dir.
- **Commands:** only fixed binaries via `execFile` with arg arrays (git, ffmpeg, claude, codex, hyperframes); never a shell with interpolated user/agent text.
- **Untrusted repos:** agents never run with cwd inside a tracked repo (non-bare `claude -p` would load that repo's hooks and `.mcp.json`). Instead: cwd = fresh workspace; repo context passed as a prepared bundle (git log, diffstat, README, selected files); deep-read tasks get the repo via `--add-dir` with read-only tools / Codex `read-only` sandbox. Repo text is treated as data, not instructions. **Verified in PoC-1.**
- **Generated compositions:** rendered in headless Chromium on a separate origin with network blocked; agents can write only to their composition dir.
- **Secrets in content:** scan drafts and context bundles with secret-pattern rules (gitleaks-style) + check against `private.md` terms before approval; warn on screenshots of URLs/paths that look sensitive.
- **Tokens:** OS keychain; never logged; never shown to agents.
- **Approvals:** required for publish, deleting content, running a capture script against a URL, and any agent write outside its workspace (not allowed by default).

---

## M. Milestones (reordered: spikes first, assisted publishing in M2 so v0.1 is usable end to end)

**M0 — Spikes (≈2–3 days).** Throwaway scripts in `spikes/`, kept for reference.
- PoC-1 Agent harness: spawn `claude -p` and `codex exec` from Node in an isolated workspace with read-only `--add-dir` to a repo containing a **canary** hook, `.mcp.json`, and CLAUDE.md/AGENTS.md; confirm none execute; get schema-valid JSON; cancel and resume work.
- PoC-2 Draft quality: real `git log` range from `~/projects/portfolio` → X + LinkedIn drafts; judge quality with you.
- PoC-3 Image: screenshot + HTML preset → Playwright PNG; agent edits headline; pixel-diff confirms screenshot untouched.
- PoC-4 Video bake-off: one Playwright scripted demo of a local app + event log, then the **same** 15 s 1080p video with click-zooms and captions built in **HyperFrames and in Remotion** by the same agent. Score: output quality (your judgment), agent first-try success, one conversational revision that changes only the intro, render time, setup weight, license fit.
- PoC-5 `.bip` storage: write/read/migrate story+post files under concurrent writes; confirm `.git/info/exclude` keeps `git status` clean in a normal repo and a worktree.
- Accept: each PoC has a short written result; recorded decision on the video engine and go/no-go on CLI-based agents.

**M1 — Foundation.** Scaffold workspace, server, `app.db` + migrations, `.bip/` store (schemas, atomic writes, lock, exclude handling), dark UI shell, add folder → discover repos → select, manual add/remove/relink, project dashboard with git activity, project overview, Context tab, `bip doctor`, `bip backup`.
- Accept: add `~/projects`, see all ~19 repos discovered, track 3, see branch + commits since last share; `git status` in tracked repos is unchanged after BIP writes `.bip/`; moving a repo dir re-links on rescan with its content intact; restart preserves everything.

**M2 — Post Studio + assisted publishing (v0.1 release candidate).** Agent adapters + job runner + SSE; stories; generate X/LinkedIn drafts from commits/context/blank; rewrite actions + free-form; revisions + restore; cross-platform adapt; follow-ups; secret/private check; publish sheet; mark published → advances last-shared; Content list.
- Accept: from commit selection to two drafts in < 60 s; every edit creates a restorable revision; switching default agent works; killing the server mid-generation shows "interrupted" with working Resume; nothing leaves the machine except agent calls.

**M3 — Image Studio.** Upload/capture screenshots (URL + optional steps), 4 presets, slots UI, agent edits, aspect ratios, export, revision strip, attach to posts.
- Accept: screenshot → polished 1200×675 PNG in < 30 s; 3 sequential edits each revertible; fidelity check passes on untouched screenshots and fails if a filter is applied.

**M4 — Video Studio.** Scripted browser demo capture + event log, import video, HyperFrames compose/lint/frame-review/preview/render, 2 styles first (Clean, Technical), conversational edits with git-backed revisions, attach to posts.
- Accept: URL + description → ≤ 30 s MP4 with click-zooms and captions; "shorten intro" changes only the intro scene (diff shows it); render jobs survive app restart (resume or clean fail).

**M5 — Direct publishing + scheduling (optional by design).** X and LinkedIn OAuth with user's own apps, keychain tokens, media upload, publish jobs with retries, status + URLs, scheduling + Scheduled view (or Calendar), systemd timer option.
- Accept: approved post with image publishes to both; failure shows actionable error and allows retry; unapproved/changed revision can't publish.

**M6 — Release.** Setup script + doctor polish, docs (architecture, security, contributing, dependency licenses), sample demo project, tests on critical paths (git parsing, migrations, adapters with recorded streams, path allowlist), make repo public.

Tests are written alongside each milestone (not deferred to M6): unit tests for git/parsers/path checks, recorded-stream tests for agent adapters, one Playwright e2e for the core loop.

---

## N. Main technical risks

| Risk | Why it's hard | Mitigation / PoC |
|---|---|---|
| Agent auth & policy | Rules changed twice in 2026; credit metering | Spawn unmodified CLIs only; show cost per run; API-key mode as fallback; doctor checks versions |
| Repo prompt-injection / hook execution | Non-bare `claude -p` loads project settings/hooks/MCP | Never cwd into repos; canary test in PoC-1 |
| CLI output drift | stream-json/`--json` event shapes change between versions | Normalize in adapters; recorded-fixture tests; min-version check |
| Video quality judged by agents | Agents can't "watch" video | Frame contact sheets + lint + human preview loop; keep edits small |
| Recording fidelity on Linux | Playwright video is low bitrate; Wayland screen capture is painful | Browser-only capture via CDP at fixed viewport; desktop capture deferred |
| Render time | Headless Chrome + FFmpeg per frame | Low-res previews, final render only on demand, one render at a time |
| Screenshot accuracy | Agents may "improve" UI text | Read-only assets, lint, pixel diff |
| Social APIs | X pay-per-use cost, LinkedIn token expiry/approval | Assisted publishing first; direct API optional |
| Cross-platform | keychain, paths, Chromium deps | Node + XDG-style abstraction (`env-paths`), no Linux-only APIs in core |

## O. Scope reduction (what v0.1 is)

**In v0.1 (M1+M2):** projects, context, stories, X+LinkedIn drafts with rewrite/revisions, assisted publishing, Claude+Codex adapters.
**Next (v0.2–0.3):** Image Studio, then Video Studio (2 styles).
**Deferred:** Calendar, scheduling, direct API publishing, generative images, sound effects/music library, Energetic/Cinematic styles, desktop/terminal recording, Windows/macOS packaging, multiple accounts per platform, Postiz adapter, Docker, Electron/Tauri wrapper.

---

## P. Setup experience (target)

```bash
git clone … && cd build-in-public
corepack enable && pnpm install
pnpm setup      # doctor: node≥22, git, ffmpeg, Playwright Chromium, claude/codex detected+authed, hyperframes
pnpm start      # opens http://127.0.0.1:4310 → onboarding: pick agent → add projects folder
```

## Verification (for this planning phase)

- After approval: run the Git commands in §0, then `git remote -v` and `git ls-remote origin` show the correct, still-empty remote; `git status` on branch `main`.
- Then M0 spikes produce pass/fail notes before any app code is written.

## Decisions (from the question rounds)

| Decision | Choice |
|---|---|
| Project storage | In-repo `.bip/` for all per-project content; small central `app.db` for registry/jobs |
| `.bip/` vs git | Hidden via `.git/info/exclude` by default; per-project opt-in to commit `context.md` only |
| Video engine | Decided after the PoC-4 bake-off (HyperFrames vs Remotion) |
| v0.1 scope | Projects + context + X/LinkedIn post studio + assisted publishing; images in v0.2, video in v0.3, API publishing later |
| Agent routing | Ask per task (picker on every agent action; preselects the last-used agent for that task type) |
| Navigation | Projects / Content / Settings; project tabs Overview / Stories / Media / Context / Settings; studios are full-screen editors |
| License | MIT |
| Git identity (repo-local) | Saurav Singh Chandel `<sauravca527@gmail.com>` |

**Deferred decisions (don't block M0–M2):** image presets' exact look (M3), which video styles beyond Clean/Technical (M4), Calendar vs. a Scheduled list (M5), Windows/macOS support (after M6), packaging as `npx` vs clone-only (M6).

## Next steps after approval
1. Run §0 Git commands and verify the remote.
2. Commit only `README.md` (one-paragraph vision), `LICENSE` (MIT), `.gitignore`, and this plan as `docs/plan.md`. Push only with your OK.
3. Run M0 spikes in `spikes/` and report results before scaffolding M1.
