# Spike: video bake-off (PoC-4: HyperFrames vs Remotion)

Folder: `spikes/video/`

Goal: decide which engine powers Video Studio. Make the **same** ~15 s 1920×1080 30 fps product demo of the user's portfolio site in both engines, from the same recording and event log, then apply the same revision to each. You are the "agent" authoring both. Use each engine's official agent skills/docs: HyperFrames ships skills via `npx hyperframes skills update` / `npx skills add heygen-com/hyperframes`; Remotion has `remotion-dev/skills`. Install the skills locally in the spike folder if possible, and read them. Don't rely on memory of the APIs.

## Step 1 — Capture (shared)
- Serve a copy of `~/projects/portfolio/out/` (static export; copy it to `/tmp/bip-spike-video/site`) on 127.0.0.1.
- Write `capture.mjs`: Playwright Chromium, viewport 1440×900, a scripted demo of about 12–15 s: land on the homepage, pause, smooth-scroll down through sections, hover and click one or two real links or nav items, scroll back up. Inject a small script that logs pointer moves, clicks, and scrolls with timestamps, plus Playwright's own action timestamps → `out/capture/events.json`.
- Record video. Try **both** (a) Playwright `recordVideo` at 1440×900 and (b) CDP `Page.startScreencast` frames (JPEG quality ~90, with timestamps) assembled with FFmpeg at a constant 30 fps. Compare visual sharpness and dropped frames, and keep the better one as `out/capture/raw.mp4`. Report bitrate, effective fps, and file size for both.
- Hide the real cursor; both compositions will draw a synthetic cursor from `events.json`.

## Step 2 — Build the demo in each engine
Spec, identical for both:
- 0–2.5 s: intro title card "Portfolio v2" + subtitle "Rebuilt with Next.js" (kinetic text, restrained).
- Then the recording inside a clean rounded frame on a dark backdrop, with:
  - smooth zoom-in (about 1.6×) centred on each click 0.4 s before it happens, holding, then zooming out (eased; no jarring cuts)
  - a synthetic cursor following `events.json`, with a click ripple
  - one speed ramp: the longest scroll segment plays at 2×
  - 2 animated captions synced to moments (e.g. "Fast static export", "Clean navigation")
- Last 2 s: outro card with the site URL placeholder "yourdomain.dev".
- H.264 MP4 + AAC silent track (or no audio), 1080p30.

Engines:
- `spikes/video/hyperframes/` — HyperFrames project (`npx hyperframes init`). Use its lint, frame inspection, and preview commands where available.
- `spikes/video/remotion/` — Remotion project (blank TS template). Use `npx remotion render`. (The free Remotion license covers this individual use.)

For each engine, capture: setup steps + install size (`du -sh node_modules`), first-try problems, render wall time for the full video, whether a frame/contact-sheet check is available (otherwise produce one with FFmpeg: `out/<engine>-contact.png`, 4×4 tiles), and the number of fix iterations needed before the output matched the spec.

## Step 3 — Revision test
Initialise a git repo inside each engine project folder and commit v1. Then apply this conversational revision to each: **"The intro is too slow. Shorten it to 1.2 s, make the zooms smoother, and end on the outro 0.5 s sooner."** Commit v2. Report `git diff --stat` and whether the change stayed local (intro/zoom/outro code only), plus render time for v2.

## Step 4 — Score
In RESULT.md, include a side-by-side table: visual quality (your honest assessment, plus a note to the user to watch both), spec coverage, agent ergonomics (how easy it was for you to author and revise), render time v1/v2, install size, determinism (render twice and compare the MD5 of frame 150 via FFmpeg), license fit for an MIT project used by people at companies, and maintenance signals. End with a recommendation.

Outputs for the user to watch: `out/hyperframes-v1.mp4`, `out/hyperframes-v2.mp4`, `out/remotion-v1.mp4`, `out/remotion-v2.mp4`, contact sheets, and the raw capture. Keep each file under 20 MB (re-encode with CRF if needed). List them in RESULT.md.
