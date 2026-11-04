# Spike: image (PoC-3 screenshot showcase composition)

Folder: `spikes/image/`

Goal: prove that "real screenshot + HTML/CSS composition → polished PNG" works, that an agent can revise it safely, and that we can detect accidental changes to the screenshot.

Steps:
1. **Capture:** serve a copy of `~/projects/portfolio/out/` (static Next.js export; copy it to `/tmp/bip-spike-image/site`) with a tiny local static server on 127.0.0.1. Use Playwright to capture a 1440×900 viewport screenshot at deviceScaleFactor 2. Store it as `out/assets/<sha256>.png` (content-addressed, then chmod read-only).
2. **Composition format:** create `out/compositions/launch-1/` containing:
   - `composition.json` `{schemaVersion:1, width:1200, height:675, preset:"launch", slots:{headline, subhead, accent, background}, sources:[sha]}`
   - `index.html` + `styles.css` implementing a dark "product launch" look: subtle radial or noise background (restrained, not a loud gradient), the screenshot inside a minimal browser frame with soft shadow and slight depth, headline + subhead with good typography (use a locally available or system font; no network fonts). The screenshot `<img>` must carry `data-bip-source="<sha>"`.
   - The slot values are injected from `composition.json` by a tiny inline script, or by a render step that templates them in. Pick one and justify it.
   - Make it a git repo (`git init` inside the composition dir) and commit "initial".
3. **Render:** `render.mjs <compositionDir> <out.png>` opens the page with Playwright at viewport = composition size, DPR 2, **network blocked except file:// or the local origin**, waits for fonts and images, and screenshots the page → PNG. Measure render time.
4. **Fidelity check:** `check-fidelity.mjs` finds the `[data-bip-source]` element's bounding box, (a) lints computed styles: no `filter`, `mix-blend-mode`, `opacity < 1`, or `backdrop-filter` on the img or its ancestors within the frame, and no element with text overlapping the img box unless it has `data-bip-annotation`; (b) renders the composition, crops the img region, downscales the source to the same size, and pixel-diffs them (pixelmatch). Report the mismatch %. Calibrate a threshold that passes on the clean composition.
5. **Agent edit:** run `codex exec` (sandbox `workspace-write`, `-C` = the composition dir, `< /dev/null`) with the instruction: "Change the headline to 'My portfolio, rebuilt from scratch', make the background a bit warmer, and add one small annotation label pointing at the navigation bar. Do not alter the screenshot image." Commit the result as revision 2. Re-render and re-check fidelity.
6. **Negative test:** on a scratch copy, add `filter: saturate(1.4)` to the screenshot. The checker must FAIL it. Also add a text element over the screenshot without `data-bip-annotation`; the checker must FAIL that too.
7. Produce square (1080×1080) and 4:5 (1080×1350) variants of the same composition by changing only `composition.json` size plus responsive CSS, and render them.

Acceptance checks: capture works; 1200×675 render < 3 s warm; the clean and agent-edited compositions pass fidelity; both negative tests fail; `git log` in the composition shows 2 revisions; the 3 aspect ratios render without overflow (check that no element sits outside the viewport).

Outputs for the user to look at: `out/renders/*.png`. List them in RESULT.md.
