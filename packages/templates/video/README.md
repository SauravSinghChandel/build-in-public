# Video starters

`clean/styles.css` and `technical/styles.css` are paired with the shared, seekable
HTML generator in `apps/server/src/video/build.ts` and event model in `model.ts`.
They port the spike's timing model using WAAPI and CSS, without GSAP.
Clean provides title/outro, captions, measured click zooms and a cursor/ripple.
Technical adds terminal and annotated-still scenes and monospace captions.
Image sources receive slow pan/zoom and fades. Media uses only local SHA paths.

HyperFrames 0.9.13 runs lint, snapshot and render. BIP's video-editor skill takes
precedence over engine examples. See `docs/architecture.md` for the workflow.
