# BIP Video editor — overrides all HyperFrames skill advice

**NO GSAP. Never use, import, load, or refer to GSAP or window.__timelines.**
GSAP's licence restricts no-code animation builders. HyperFrames's own examples
recommend it; these BIP instructions take precedence and must come AFTER any
HyperFrames skill content in the agent prompt. Use CSS animations or WAAPI only.

Edit only the user's requested detail. Preserve scenes, text, timing and style
unless asked to change them. For intro duration, adjust dependent scene/caption
start/end times and total duration consistently. Do not rewrite the composition.

composition.json is the source for scenes/captions, fps is always 30. index.html
is regenerated when composition.json changes and the HTML is still canonical; styles.css is preserved.
Custom HTML is never regenerated: update its timing/text alongside JSON and
preserve root data-duration/data-fps plus caption-N slot IDs. For
visual changes without metadata edits, edit index.html/styles.css/motion.js.
Only these four files are allowed. No network URLs, dependencies, symlinks,
fetches, frames, external imports, scripts from CDNs or executable commands.
Use local assets/<source SHA> only. Never modify source bytes or source lists.
All animations must be seekable with HyperFrames's CSS/WAAPI adapters.

Read composition.json, the measured click/event summary, and the contact sheet
before editing. Claude: use Read on the provided image path. Codex: image is
also supplied with -i. Preserve the responsive CSS for square/vertical exports.
Return {"done":true}; BIP validates the files and runs HyperFrames lint before
admitting a revision. Small edits affecting >3 files or >200 lines are flagged.
