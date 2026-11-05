# Milestone M4: Video Studio

You are implementing milestone **M4** of Build in Public (BIP) on top of finished M1–M3. Read first: `docs/plan.md` (§F Video Studio, §J, §L, M4, "M0 results", Decisions), `docs/design.md`, `docs/architecture.md`, `docs/milestones/*.md`, and **`spikes/video/`** (RESULT.md, `capture.mjs`, `model.mjs`, `render.mjs`, `revise.mjs`, the `hyperframes/` project, and `out/license-notes.md`). Reuse M3's patterns: assets, composition internal git repos, workspace copy-out for agents, validation, and revision strip.

Worktree/branch: see "Environment" at the end. **Do not commit or push.** Don't edit `docs/plan.md` or `spikes/`.

## Decisions you must follow
- Engine: **HyperFrames** (pin the exact version the spike used, `0.9.13`, unless a newer patch is needed; record it in `docs/architecture.md`). Use HyperFrames's CLI for lint, snapshot (frame inspection), and render.
- **No GSAP anywhere.** Its licence restricts no-code animation builders. Compositions animate with CSS animations/transitions or the Web Animations API (HyperFrames has deterministic `css` and `waapi` adapters); anime.js (MIT) is allowed if really needed. BIP's composition validator **rejects** any reference to `gsap` (script src, import, `window.gsap`, `__timelines` GSAP usage) with a clear error. The agent skill file says so prominently. HyperFrames's own skills recommend GSAP: our `agent-skills/video-editor.md` overrides that and must be passed to the agent **after** any HyperFrames skill content.
- Capture via **CDP `Page.startScreencast`** (sharper than Playwright `recordVideo` in the spike) at a fixed viewport, plus the injected event log (pointer, clicks, scrolls, navigation, action timestamps). Zoom/cursor timing uses **measured** timestamps from the log, not planned times.

## 1. Capture
- "Record a demo" dialog: URL, viewport (1440×900 default), steps (same format and editor as M3 capture, plus `pause {ms}` and `scrollTo {selector|y, durationMs}` for smooth scrolls), and an optional "Describe the demo" → agent turns it into steps (picker). Steps are shown for **approval** before running.
- Before recording: wait for network idle + fonts; hide the real cursor (CSS + any site cursor overlays, as the spike did).
- Output: a `recording` asset (MP4 H.264, CFR 30 assembled with FFmpeg from screencast frames with their timestamps), plus `events.json` stored next to it (as an asset, kind `event_log`, linked via provenance).
- **Capture-quality gate** (from the spike): compute effective delivered fps and max frame gap. If fps < 12 or the max gap is > 500 ms, mark the recording "Choppy" in the UI and suggest "Record again" (still usable).
- Import: upload an existing video (mp4/mov/webm ≤ 500 MB; validate with `ffprobe`), store it as a `recording` asset, and run scene detection (`ffmpeg -vf select='gt(scene,0.3)'`) → `scenes.json`. No event log for imports.

## 2. Video compositions
- `.bip/compositions/<id>/` with `type: 'video'`, an internal git repo as in M3. `composition.json` adds `fps: 30`, `durationMs`, `style`, `scenes: [{id, kind:'title'|'recording'|'still'|'outro', startMs, endMs, sourceSha?, notes}]`, and `captions: [{text, startMs, endMs}]`. Generated HTML/CSS lives alongside it.
- **Style starters** in `packages/templates/video/`: `clean` (calm eased zooms to clicks, synthetic cursor + click ripple, 2 captions, title + outro cards) and `technical` (adds a code/terminal still scene, a monospace caption style, and an annotated still with callouts). Both are GSAP-free and ported from the spike's model (`model.mjs`: zoom pre-roll .4 s, hold .35 s, ease out .65 s, edge clamping; speed ramp on the longest scroll segment at 2×). Fix the spike's known gap: click zooms must centre vertically when possible.
- Also allow "Screenshots to video": build a composition from Image Studio renders/screenshots (Ken Burns-style slow pan/zoom per still + captions + transitions).
- **Agent edits** (picker): copy-out to a workspace, run, validate (allowed files; no external URLs; **no GSAP**; HyperFrames lint must pass), copy back, commit. The prompt includes `composition.json`, the event log summary (clicks with times/positions), and the last contact sheet image path (both CLIs accept images: Claude via the Read tool on the file, Codex via `-i`), so the agent can see what it's changing.
- Conversational edits must change only what's asked. After the agent run, show `git diff --stat` in the revision entry; if more than ~3 files or 200 lines changed for a small instruction, flag "Large change" so the user can review or restore.

## 3. Preview, check, render
- Every revision gets: a **contact sheet** (HyperFrames `snapshot` at ~12 evenly spaced times, tiled into one PNG with FFmpeg) and a fast **preview render** (960×540, CRF 30). Both are jobs; the UI shows progress.
- "Render final": 1920×1080 30 fps, H.264 + AAC (silent track if no audio), CRF 20, `+faststart`, ≤ 2:20 duration (warn above X's limit). Optional square (1080×1080) and vertical (1080×1920) variants using responsive CSS.
- Renders are stored as `video_render` assets keyed by commit; they're re-used if the commit hasn't changed.
- Determinism check (cheap): after a final render, hash decoded frame 150 and store it; re-rendering the same commit should match (log a warning if not).
- HyperFrames needs `HYPERFRAMES_BROWSER_PATH` pointing at the cached Chromium and a writable `XDG_CONFIG_HOME` (the spike needed both). Set them from BIP's config. `bip doctor` checks HyperFrames + Chromium + FFmpeg.

## 4. Video Studio UI (full-screen editor per plan §F)
- Center: a `<video>` player for the latest preview/final render, with a frame-accurate scrubber.
- Below the player: a **scene timeline** (from `composition.json`: proportional blocks for scenes, caption markers, click markers from the event log). Clicking a block seeks. This is read-only in M4; drag-to-trim is later.
- Right: style picker, captions list (inline-editable text; editing a caption = a direct slot edit, no agent), the instruction box + agent picker, and "Apply".
- Left/bottom: revision list (each with thumbnail, instruction, diff stat, "Large change" flag, Preview/Restore).
- Contact sheet toggle overlays the sheet image for quick review.
- Status chips: "Choppy recording", "Lint passed", "Rendering 42%".
- Export: download the final MP4; attach to a post in a story (X/LinkedIn panels show a video chip; the publish sheet offers "Download video").

## 5. Story integration
- From the Story editor: "Add video" → "Record a demo", "Use a recording", or "From images in this story" (Screenshots to video, pre-filled with the story's attached images and its brief for captions).

## 6. Tests
- Unit: steps validation incl. new actions; quality gate maths; scene/caption schema; **GSAP rejection** (script src, ESM import, global use); external URL rejection; zoom model (pre-roll/hold/ease timing, vertical centring, edge clamping); speed-ramp selection; diff-size flagging.
- Integration: a small local fixture site (served by the test) → capture 4 s → recording asset + events → build a `clean` composition (no agent) → HyperFrames lint passes → contact sheet → 540p preview render exists and `ffprobe` shows H.264/30 fps → final render of a 3 s composition. Keep total test time reasonable (use tiny durations).
- Fake-agent integration: a scripted agent changes the intro duration in the composition → lint → commit → preview render.
- E2E (Playwright UI): open a story → Add video → Record a demo against the fixture site → approve steps → composition created → apply a caption text edit → new revision → preview plays (the video element has a duration > 0) → attach to the X post → it shows in the publish sheet.
- Keep all previous tests green. Run `typecheck`, `test`, `test:e2e`.

## Deliverable
`M4-RESULT.md` at the repo root, ≤ 50 lines.

## Environment
- Worktree `/home/justbuster/projects/build-in-public-m4`, branch `m4-video-studio` (already checked out). Install with `npx --yes pnpm@10.34.9 install`.
- Same notes as earlier milestones: `tsx`/`tsc`, cached Playwright Chromium (`chromiumSandbox: false` in tests if needed), fake agents via `BIP_CLAUDE_BIN`/`BIP_CODEX_BIN` for all tests, and `agentSchema()` for agent JSON Schemas. Real agent CLIs can't run in your sandbox; the reviewer runs the live smoke test.
- The video spike's HyperFrames project is at `spikes/video/hyperframes/` (its `node_modules` aren't committed; install HyperFrames fresh as a workspace dependency).
