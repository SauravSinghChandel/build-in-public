# Milestone M2: Post Studio + assisted publishing (v0.1)

You are implementing milestone **M2** of Build in Public (BIP) on top of the finished M1 code. Read first: `docs/plan.md` (§F, G, H, K, L, M2, and "M0 results"), `docs/design.md`, `docs/architecture.md` (from M1), `spikes/agents/RESULT.md`, `spikes/agents/harness.mjs`, `spikes/agents/post-writer.md`, and `spikes/agents/out/drafts.md` (real drafts and their problems).

Repo/worktree and branch: given in the "Environment" section at the end. **Do not commit or push.** Don't edit `docs/plan.md` or `spikes/`.

## 1. Agent adapters (`apps/server/src/agents/`)
- Port the spike harness to TypeScript: `AgentProvider` interface per plan §H, with `claude` and `codex` providers. Use the exact isolation pattern proven in M0:
  - Claude: `-p --output-format stream-json --verbose --json-schema --permission-mode dontAsk --allowedTools <list> --add-dir <dirs> --strict-mcp-config --setting-sources user`, cwd = fresh workspace under `<appdata>/workspaces/<jobId>`.
  - Codex: `exec --json --output-schema <file> -s read-only -C <workspace> --add-dir <dirs> --skip-git-repo-check`, stdin closed.
- Binary paths come from config, with env overrides `BIP_CLAUDE_BIN` / `BIP_CODEX_BIN`. Tests use these overrides to point at **fake agent scripts** that replay recorded JSONL fixtures. Build fixtures from the real event logs in `spikes/agents/out/*.events.json`. Fakes must cover success, schema-invalid output, non-zero exit, slow output (for cancel), and resume.
- Normalized events, cancel (SIGINT → SIGTERM after 2 s, process-group kill), resume by session id, raw JSONL saved to `<appdata>/logs/agents/<runId>.jsonl`, cost captured when reported.
- `GET /api/agents/status` from M1 stays and also reports which providers are usable.

## 2. Job runner (`apps/server/src/jobs/`)
- Uses the `jobs` + `agent_runs` tables.
- In-process worker: max 2 concurrent agent jobs, at most 1 per `resource_key` (e.g. `post:<id>`), FIFO otherwise.
- `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/resume`.
- On server start, `running` jobs become `interrupted`. "Resume" re-runs with the stored session id when the provider supports it, otherwise re-runs from scratch.
- `GET /api/events` (SSE, cookie-auth) streams job lifecycle + progress + partial text. Reconnects resume via `Last-Event-ID` (keep a small ring buffer).

## 3. Content model (in `.bip/`, per plan §G)
Stories, posts, revisions using the M1 store: create/list/get/update stories; create posts per platform; append revisions; restore (= append a new revision copied from an old one, author `user`, instruction "Restored revision N"); approve (binds `approvedRevisionId`; any later revision clears approval); mark published `{url}` → status `published`, `publishedAt`, `publishedUrl`. If this is the story's first published post, advance `project.lastSharedCommit` to `story.commitRange.to` **only if** that commit is a descendant of the current marker (`git merge-base --is-ancestor`).

## 4. Drafting flow (the heart of v0.1)
- **Context bundle builder:** project name, `context.md`, `auto-summary.md` (if present), README excerpt (≤ 80 lines), the selected commits with `--stat` and truncated diffs (per-file cap 120 lines, total cap ~40 KB, skip lockfiles/binaries/generated dirs), and the user's free-text note. `private.md` goes in a separate "Never mention" section. Run a **secret scan** (gitleaks-style regexes: AWS/GCP/GitHub/OpenAI/Anthropic/Slack/Stripe tokens, private keys, `.env`-style `KEY=…` lines, JWTs) over the bundle and redact matches before any agent sees it.
- **Step 1 — Angles:** "Create story from N commits" → job `story.angles`: the agent returns 3 angles `{title, hook, why_interesting, commits[]}`. UI shows them as selectable rows plus "Write my own angle".
- **Step 2 — Draft:** the chosen angle → job `post.draft` for X and LinkedIn **in one agent call** (schema like the spike: `x.parts[]`, `linkedin.text`, `highlights[]`, `claims_to_verify[]`). Creates 2 posts with revision 1 each.
- **Post-writer prompt** in `agent-skills/post-writer.md`. Improve on the spike version with these M0 fixes:
  1. Focus on the chosen angle; mention other commits only if they support it. Never produce a changelog list.
  2. Caveats/uncertainty go **only** in `claims_to_verify`; the post text never talks about what the commits do or don't prove.
  3. Voice: a developer casually sharing what they built or learned. Concrete details over adjectives. No hype words (e.g. "excited to announce", "game-changer", "leverage"). Max 1 hashtag, usually 0. No emoji unless the project's tone setting allows it.
  4. X: one post ≤ 280 chars by default; a thread (≤ 4 parts, numbered "1/3") only when the angle needs it. LinkedIn: 600–1,200 chars, first line is a hook that stands alone, short paragraphs.
  5. Respect project settings `tone` and `audience` if set, and the "Never mention" list.
- **Edit actions** (each = one agent job resuming nothing; send the current text + bundle summary + instruction; returns the same schema for that platform only; appends a revision with `instruction`): Regenerate, Shorten, Expand, Tone (Casual / Technical / Professional / Playful), Adapt from <other platform>, Follow-up (creates a new post with `replyToPostId`), and free-form instruction. Also manual edits by the user: debounced 1.5 s → revision author `user` (coalesce consecutive manual edits within 60 s into one revision).
- **Agent picker (decided: ask per task):** every agent-triggering button has an adjacent Claude/Codex segmented control. It preselects the last agent used for that task type in that project (stored in `project.json` `settings.lastAgent[taskType]`); unusable providers are disabled with a hint.
- **Validation in code** after every agent result: lengths (X parts ≤ 280 with URL-length rule: count any URL as 23), hashtag count, LinkedIn length. Out-of-range results are still saved but flagged in the UI with a "Shorten" suggestion.

## 5. Publish sheet (assisted, plan §K)
- Opens from a post. Shows the final preview, a checklist (secret scan of the final text, "Never mention" term matches as warnings, unresolved `claims_to_verify` as checkboxes the user ticks), then "Approve".
- Once approved: "Copy text" (per part for threads), "Open X" (`https://x.com/intent/post?text=<part 1>`; for threads, copy buttons per part plus a note), "Open LinkedIn" (copies the text, then opens `https://www.linkedin.com/feed/?shareActive=true&text=<encoded>`; if the text is too long for a URL, open `https://www.linkedin.com/feed/` and rely on the clipboard).
- "Paste the published link" input validates the URL host (x.com/twitter.com, linkedin.com) → "Mark as published".
- The app never posts anything itself.

## 6. UI (follow `docs/design.md`)
- **Overview:** the selection action bar's "Create story from N commits" is now enabled → opens the angle step in a right-side sheet. The sidebar shows active stories and the last published post.
- **Stories tab:** a list of stories (status, platforms, updated). A story page is the **Story editor** per design.md/plan §F: title + brief, side-by-side X and LinkedIn draft panels (stacked < 1100px) with char counters, thread part editing (add/remove/reorder parts), the action bar with the agent picker, a free-form instruction box, a revision timeline (per post) with diff-on-hover and Restore, a `claims_to_verify` list, and status chips.
- **Job feedback:** an inline streaming area in the panel being generated (show partial text if available, else a quiet progress line with elapsed time) and a Cancel button. Global: a small jobs indicator in the rail showing running jobs; failed jobs show the error + "Retry".
- **Content page (global):** a table of posts across projects, filterable by project/platform/status, linking to stories.
- **Projects list:** `lastPostAt` is now real.
- **Context tab:** "Generate summary" button → job `project.summary`. The agent gets **read-only** access to the repo via `--add-dir` (Claude tools `Read,Grep,Glob` only; Codex `-s read-only`) and writes back a structured summary (what it is, who it's for, stack, notable parts) to `auto-summary.md` with the HEAD sha in front matter. Show "Summary is from an older commit" when HEAD has moved.

## 7. Tests (must pass)
- Unit: adapter arg construction (snapshot), stream parsing from the real fixtures, cancel/resume with fakes, job runner concurrency + per-resource exclusivity, restart → interrupted, SSE resume, context bundle caps/redaction (plant fake secrets), length validator incl. URL rule, revision restore/approval invalidation, lastSharedCommit advance rules (ancestor/non-ancestor), publish URL validation.
- E2E (Playwright, fake agents via env overrides): select 3 commits → angles → pick → two drafts appear → Shorten X → a new revision → Restore revision 1 → approve with checklist → publish sheet shows the intent URL → paste URL → marked published → Projects list shows the last post and a reduced unshared count; kill the server mid-draft (fake slow agent) → restart → job shows Interrupted → Resume completes.
- Keep all M1 tests green. Run `typecheck`, `test`, `test:e2e`.

## Deliverable
`M2-RESULT.md` at the repo root, ≤ 50 lines: built, tests, deviations, gaps, how to try it with real agents.

## 0. First: M1 polish and refactor (from the reviewer's browser pass)
Do these before adding M2 features:
1. **Split `apps/web/src/App.tsx` (~1,450 lines)** into routes and feature modules (e.g. `routes/`, `features/projects/`, `features/project/overview/`, `features/project/context/`, `features/settings/`, `components/`). No behaviour change; keep the tests green.
2. **Project tabs become URL routes:** `/projects/:id` (overview), `/projects/:id/stories`, `/projects/:id/stories/:storyId`, `/projects/:id/media`, `/projects/:id/context`, `/projects/:id/settings`. The browser Back button must work.
3. Secondary/outline buttons (Rescan, Cancel, Clear, Open folder) currently have a bright white border. Use `--line`, plus `--muted` on hover.
4. Toasts render in monospace. Use IBM Plex Sans.
5. Show paths under `$HOME` as `~/…` everywhere (the full path stays in a tooltip and on copy).
6. Commit rows: hide the author when it matches the repo's `git config user.email`/`user.name` (resolve once per project).
7. The brand "Build in Public" wraps onto 2 lines in the rail. Keep it on one line (14/600) or shrink the rail padding.
8. Replace the native `<datalist>` folder autocomplete (an unstyled ▼, popups invisible in some browsers) with a styled combobox: a popover list under the input, arrow-key navigation, Tab to complete. A prefix of `~` or `~/` lists the home folder's children instead of returning 400.
9. Toast copy: "Shared marker updated" → "Marked as shared". Command hints in Settings → Agents render commands in mono (`claude`, `codex login`).

## Environment
- Worktree `/home/justbuster/projects/build-in-public-m2`, branch `m2-post-studio` (already checked out). Install with `npx --yes pnpm@10.34.9 install`.
- Same notes as M1: `tsx`/`tsc` (system Node has no TS stripping), cached Playwright Chromium, `chromiumSandbox: false` in test config if needed.
- Real agent CLIs can't run inside your sandbox (their config dirs are read-only). Use the fake-agent overrides for all tests. The reviewer will run a live smoke test with the real CLIs afterwards, so make sure `BIP_CLAUDE_BIN`/`BIP_CODEX_BIN` unset = the real `claude`/`codex` on PATH.
