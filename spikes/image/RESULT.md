GO-with-caveats — screenshot composition works; safe agent revision remains unproven because Codex failed to initialize twice.

All paths below are relative to `spikes/image/`. No app implementation was added.

| Acceptance check | Result | Evidence |
|---|---|---|
| Capture real portfolio copy | PASS | `out/logs/capture.json`: 1440×900 viewport, DPR 2, 2880×1800 PNG, 604,316 bytes; no page errors. |
| Immutable content-addressed source | PASS | `out/assets/f14b5d2ed8eb5b35cfa561c945801866ad66d9576e9cdfe069f279177a85514e.png`; mode 0444; hash unchanged after revision. |
| HTML/CSS + schema/slots/source marker | PASS | `out/compositions/launch-1/{composition.json,index.html,styles.css}`; system Noto Sans, local assets. |
| Warm 1200×675 render <3 s | PASS | Five measured page-load/font/image-wait/PNG renders in `out/logs/verification.json`; 351–381 ms, browser launch excluded. |
| Clean composition fidelity | PASS | `out/logs/initial-fidelity.json`: 2.4164% mismatch, no lint errors; calibrated limit 3.0%. |
| Codex changes headline/background/annotation | FAIL | `out/logs/agent.stderr` and `agent-retry.stderr`: both exit 1, “failed to initialize in-process app-server client: Read-only file system (os error 30)”. |
| Agent-edited composition fidelity | FAIL | No agent output. Explicit **manual fallback** revision passes at 2.4214%; `out/logs/edited-fidelity.json`. |
| Saturation negative rejected | PASS | `out/logs/negative-filter.json`: `filter=saturate(1.4)` lint rejection. Pixel mismatch alone is only 2.4294%. |
| Unmarked text negative rejected | PASS | `out/logs/negative-text.json`: overlapping text rejected; 5.0361% pixel mismatch. |
| Composition git has 2 revisions | PASS | `82661ec initial`, `88a5368 revision 2 (manual fallback; Codex startup failed)`; patch in `out/logs/revision-2.patch`. |
| 16:9, 1:1, 4:5 without overflow | PASS | `verification.json`: zero out-of-viewport element boxes at 1200×675, 1080×1080, 1080×1350; variants change only JSON size, identical HTML/CSS. |
| External render network blocked | PASS | Local origin allowlist, service workers blocked; explicit HTTPS probe rejected (`networkBlocked:true`). |

Gotchas and implementation choices:
- Node 22.22.1; Playwright 1.64.1; cached chromium-1248 / Chromium 156.0.8078.4; pixelmatch 7.1.0; pngjs 7.0.0; Codex CLI 0.166.0. No browser download needed.
- `chromiumSandbox:false` was used. PNG output is 2× the logical composition dimensions.
- JSON slots use a tiny inline fetch script + `textContent`/CSS custom properties; avoids duplicated templates, preserves escaping, and exposes an explicit `bipReady` render barrier.
- Two canvas-reference calibration attempts showed ~2.4% mismatch at landscape scale (fractional sizing changes did not remove it); browser CSS/canvas resampling differ. Square/portrait mismatch is 0.00336%. Annotation pointers contribute a few changed pixels.
- Pixelmatch uses per-pixel threshold 0.1, excludes antialiasing, and allows 3% overall mismatch. This is a calibrated guard, not proof of exact visual identity; small changes can escape the pixel threshold. CSS lint is essential.
- Checker re-hashes source bytes, validates the displayed source URL, checks img/ancestor filter/blend/opacity/backdrop styles, and rejects unmarked overlapping text. Rotated/transformed sources are rejected; arbitrary hostile HTML/pseudo-elements are outside this PoC.
- Codex used `exec --ignore-user-config --ephemeral --json -s workspace-write -C <compositionDir> ... < /dev/null`. Retry also set `TMPDIR`, `log_dir`, and `sqlite_home` under `/tmp/bip-spike-image/`; startup still failed. Stopped after two failures; no credentials inspected/copied, no CLI approval escalation attempted.
- `.gitignore` cannot express size rules: `verify.mjs` enumerates exact output paths above 20 MiB. None currently exceed that size; total outputs ~4.5 MiB.

Recommendation: proceed with local-origin HTML/CSS presets, immutable source hashes, slot edits, responsive CSS, and combined style/pixel guards. Use browser-consistent scaling baselines to tighten the threshold, bound annotation regions, and rerun the CLI revision check in a working isolated agent runtime before claiming agent-edit support.

Outputs to inspect:
- [Initial landscape](out/renders/launch-initial.png) — 2400×1350 PNG.
- [Revision 2 landscape (manual fallback)](out/renders/launch-revision-2.png) — 2400×1350 PNG.
- [Square](out/renders/launch-square.png) — 2160×2160 PNG.
- [4:5 portrait](out/renders/launch-portrait.png) — 2160×2700 PNG.

How to re-run (from `/home/justbuster/projects/build-in-public`):
```bash
npm ci --prefix spikes/image --no-audit --no-fund
node spikes/image/verify.mjs > spikes/image/out/logs/verify.stdout.json
# Expected exit 1: compositionChecksPass=true, pass=false because Codex never edited it.
node spikes/image/render.mjs spikes/image/out/compositions/launch-1 spikes/image/out/renders/launch-revision-2.png
node spikes/image/check-fidelity.mjs spikes/image/out/compositions/launch-1 spikes/image/out/logs/edited-fidelity.json
# Optional fresh capture: records a NEW hash (animated portfolio); existing compositions retain original.
mkdir -p /tmp/bip-spike-image/site
cp -a /home/justbuster/projects/portfolio/out/. /tmp/bip-spike-image/site/
node spikes/image/capture.mjs
# Optional exact second CLI attempt; may edit the composition if startup succeeds:
bash spikes/image/agent-edit.sh
```
