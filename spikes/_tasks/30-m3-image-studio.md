# Milestone M3: Image Studio

You are implementing milestone **M3** of Build in Public (BIP) on top of finished M1 + M2. Read first: `docs/plan.md` (§F Image Studio, §I, §L, M3, "M0 results"), `docs/design.md`, `docs/architecture.md`, and **`spikes/image/`** (RESULT.md, `render.mjs`, `check-fidelity.mjs`, `capture.mjs`, and the composition in `out/compositions/snapshots/launch-1/`). Port and harden the spike code; don't start from scratch.

Worktree/branch: see "Environment" at the end. **Do not commit or push.** Don't edit `docs/plan.md` or `spikes/`.


## 0. First: M2 fixes from the reviewer's live test (real Claude + Codex)
The live flow works end to end. Fix these before starting M3 features, with tests where noted:
1. Commit list **Shift-click range selection** doesn't work (only the two clicked rows get selected). Fix and add an e2e assertion.
2. **Agent picker** selected state isn't visible (the `aria-pressed` button looks the same as the other). Style the pressed segment (`--raised` background, `--text` colour, 1px `--line`).
3. **Angle sheet** layout: the "What would you like to share?" textarea is ~360px tall (make it 3 rows, auto-grow); a stray radio dot floats mid-sheet; the angle radios are tiny. Make each angle a full-width selectable row with a clear selected state (left 2px `--signal` bar + `--raised` bg); "Write my own angle" is the last such row.
4. **Story brief is empty** after drafting. Fill it at creation from the chosen angle (`hook` + `why_interesting`; for a custom angle, the user's text).
5. **Rail jobs panel** dumps the raw error text into the nav. Replace it with a compact line ("1 job failed" / "2 jobs running"; pluralised correctly) that opens a popover listing jobs (newest first) with type, project, status, a short error, Retry, and Dismiss. Dismissed failed jobs stop counting. `GET /api/jobs` should return newest first and include `startedAt`/`finishedAt` (they're null in the response today).
6. The **rail doesn't extend to full height** on long pages (its background ends at the first viewport). Make it `position: sticky; top: 0; height: 100dvh`.
7. **Story editor action bar** wraps unevenly over 2 rows. Lay out as one toolbar row: `[agent picker] Regenerate · Shorten · Expand | Tone ▾ (applies on change; drop the separate "Apply tone" button) | Adapt from <other> | Follow-up`, wrapping as a group under 900px.
8. Single X posts show the label "X part 1". Use "Post" for a single post; show "Part n of m" only for threads.
9. **Publish sheet:** when the pasted link has the wrong host, show the inline error "Paste a link from x.com" / "Paste a link from linkedin.com" instead of only disabling the button.
10. **Secret redaction is too aggressive:** it redacted a normal code line that reads a token (`… = socket.handshake.auth.token`), which confused the agent. Limit the `KEY=value` rule to `.env`-style lines (`^[A-Z0-9_]+=` in env/config files) with literal values; keep the provider-token, private-key, and JWT patterns everywhere. Add unit tests: code identifiers/property accesses are not redacted; real-looking tokens are.
11. **Folders outside `$HOME`** (e.g. `/mnt/code`) are rejected. Allow any absolute folder the user explicitly adds via "Find repositories" (it becomes an allowed root once tracked). Autocomplete stays limited to `$HOME`. Add tests.
12. Settings → Agents shows "Run codex login to sign in" even when signed in. Show the hint only when auth is missing or unknown.

## 1. Assets
- `.bip/assets/` is content-addressed (store from M1). Add `assets/index.json` metadata: kind (`screenshot|upload|image_render`), mime, width, height, createdAt, provenance (`{type:'capture', url, steps?, viewport}` | `{type:'upload', filename}` | `{type:'render', compositionId, commit}`).
- `POST /api/projects/:id/assets` (multipart upload: png/jpg/webp ≤ 20 MB; validate magic bytes, not just the extension); `GET /api/projects/:id/assets`; `GET /api/projects/:id/assets/:sha` (served with the correct content type, `Cache-Control: immutable`, `X-Content-Type-Options: nosniff`).
- The Media tab lists assets + compositions in a grid (thumbnails generated with FFmpeg or Playwright into `~/.cache/build-in-public/thumbs/`) with filters (Screenshots, Uploads, Images) and actions "New image", "Capture", and "Upload".

## 2. Capture (plan Mode 2)
- Capture dialog: URL (http/https; localhost is allowed), viewport preset (1440×900, 1280×800, 390×844), DPR 2, full page or viewport, an optional element selector to clip, wait-for (network idle / selector / delay), plus optional **steps**.
- Steps format: `[{action:'click'|'type'|'scroll'|'hover'|'wait'|'press', selector?, text?, value?, ms?}]`. There's a simple manual steps editor, and a "Describe steps" box that asks an agent (picker, ask-per-task) to turn plain language into steps JSON. Agent-generated steps are **always shown to the user for approval** before running.
- Capture runs as a job with Playwright Chromium (cached browsers) in a fresh context, with no access to the app's cookies. It stores the PNG as a `screenshot` asset with provenance and shows it in Media.

## 3. Compositions
- Stored at `.bip/compositions/<id>/`, each an **internal git repo** (init on create; one commit per revision; commit messages carry the instruction; author "Build in Public <bip@localhost>" via `-c user.name -c user.email`, never touching global config). Files: `composition.json` (`schemaVersion, id, type:'image', title, preset, width, height, slots{...}, sources:[sha]`), `index.html`, `styles.css`, optional local fonts/SVG.
- **Presets** in `packages/templates/image/`: `minimal`, `launch` (port the spike's), `technical` (screenshot + 2–3 numbered callouts with leader lines, labelled via `data-bip-annotation`), and `comparison` (before/after, two sources, a divider + labels). Each preset is responsive across sizes: X 1200×675, LinkedIn 1200×627, square 1080×1080, portrait 1080×1350. Defaults are tasteful, dark, and restrained. Background options: solid, subtle radial, soft noise, or a colour pulled from the screenshot's dominant tones. **No external network resources**; fonts are bundled locally (IBM Plex is already in the web app; ship WOFF2 files inside the template).
- Slots are edited in the UI directly (headline, subhead, accent colour, background style, frame style: none/browser/window/phone, padding, shadow strength, annotation texts). Each slot change commits a revision (debounced 1.5 s, coalesced).
- **Agent edits:** free-form instruction plus the agent picker. The job **copies the composition to a fresh workspace outside the repo** (`<appdata>/workspaces/<jobId>/comp`). Never run an agent with cwd inside a user repo: that would load the repo's `.claude/settings.json` hooks; see the M0 agents result. Source assets are copied in read-only. The agent edits; then BIP validates (allowed files: `.html .css .json .svg .woff2`, each ≤ 1 MB; HTML lint: no `<script src>` other than BIP's slot loader, no external URLs, no `<iframe>/<object>/<embed>`, no inline event handlers) → fidelity check → copies back → commits. If validation fails, show the reasons and keep the previous revision. Give the agent a short skill file (`agent-skills/image-composer.md`): composition contract, slot loader, `data-bip-source`/`data-bip-annotation` rules, "never alter screenshots", design guidance (restraint, typography, contrast).
- Revision strip: thumbnails of each revision; click to preview; "Restore" = new commit with the old tree.

## 4. Rendering + fidelity (port from the spike)
- Renders are served from a **separate local origin** (a second listener on 127.0.0.1 with a random port, no cookies, and CSP `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'`) which only serves the composition files + its source assets. Playwright blocks every request not to that origin.
- Render → PNG at DPR 2 → stored as an `image_render` asset; `renders/<compId>/<commit>.png` keeps a quick lookup.
- Live preview in the studio: an iframe pointing at the render origin (sandboxed iframe: `sandbox="allow-scripts"`, without `allow-same-origin`), scaled to fit, refreshed on each revision.
- Fidelity check after every agent revision and before export: the CSS lint + pixel diff from the spike (3% limit, calibrated), plus a check that the source asset bytes still hash to their sha. The UI shows a small "Screenshot unchanged" ✓ or a clear warning listing what's wrong. The user can override with an explicit "Allow edits to screenshot" toggle per composition (recorded in composition.json).
- Overflow check: no element outside the canvas.

## 5. Export + attach
- Export: PNG (DPR 2) or JPEG (quality 90), at the composition's size or another preset size (re-render with responsive CSS). The file downloads in the browser; the render is kept as an asset.
- From the Story editor (M2): "Add image" → pick an existing render/asset or "New image from screenshot" (opens the studio with `storyId` preset). Attached images show in the post panel and are included in the publish sheet as "Download image" (and, where the browser supports it, "Copy image").
- Alt text field per attached image (agent can suggest it: "Suggest alt text" with the picker).

## 6. Image Studio UI (full-screen editor, per plan §F and design.md)
Center: canvas preview with fit/100% zoom. Left: sources (screenshot thumbnails, swap source), preset picker (4 thumbnails), size picker. Right: slots form + instruction box + agent picker + "Apply". Bottom: revision strip. Top bar: title (editable), "Screenshot unchanged" status, Export, Close (back to where it was opened from). Keyboard: ⌘Z/⌘⇧Z = previous/next revision (restore), `F` = fit.

## 7. Tests
- Unit: magic-byte validation; asset index; steps schema; composition validation (planted `<script src=https://…>`, `onerror=`, iframe, oversize file, disallowed extension); fidelity (clean pass, filter fail, unmarked overlay fail, tampered source bytes fail); revision commit/restore; workspace copy-out/copy-in leaves the user repo untouched (`git status` clean).
- Integration with the fake agent: a scripted agent edits the headline → new revision → render → fidelity pass.
- E2E (Playwright): upload a screenshot → New image → launch preset → change headline in slots → revision 2 → switch to square → export PNG (download event) → attach to an X draft in a story → it appears in the publish sheet.
- Keep all M1/M2 tests green. Run `typecheck`, `test`, `test:e2e`.

## Deliverable
`M3-RESULT.md` at the repo root, ≤ 50 lines.
