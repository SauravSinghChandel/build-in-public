# Extending BIP

BIP has no plugin system. Presets, styles, actions and platforms are added in the source, and most of them are listed in a few hard-coded places. This page lists those places. Run `npx --yes pnpm@10.34.9 typecheck` after a change: most of the lists are typed enums, so the compiler finds the ones you missed.

## Add an image preset

An image preset is a folder of static files that BIP copies into each new composition.

1. Create `packages/templates/image/<name>/` with `index.html` and `styles.css`. You may add `.svg`, `.woff2` and `.json` files (each at most 1 MB). The validator rejects scripts, inline event handlers, `iframe`/`object`/`embed`/`base`, `@import`, `javascript:` and any external URL, so fonts and images must be local. Copy `minimal/` as a starting point; it uses the bundled IBM Plex (`plex.woff2`, licence in `packages/templates/image/OFL.txt`).
2. Mark the editable parts. BIP injects a slot loader at render time that fills:
   - `data-slot="headline"` and `data-slot="subhead"` (text content),
   - `<img data-source-index="0" data-bip-source="">` (the screenshot; `1` for a second source),
   - `[data-bip-frame]` around each screenshot (sized to fit the stage),
   - `data-annotation-index="0".."n"` (numbered annotations),
   - CSS variables `--accent`, `--padding`, `--shadow`, and `data-background` / `data-frame` on `<body>`.

   Use the full canvas: `.canvas { width: 100vw; height: 100vh }`. Rendering fails if content overflows it.
3. Add `<name>` to `ImagePreset` in `packages/shared/src/index.ts`.
4. Add it to the preset lists in `apps/web/src/features/image/Media.tsx` (New image dialog) and `apps/web/src/features/image/Studio.tsx`, and add a picker thumbnail at `apps/web/public/presets/<name>.svg`.
5. If the preset needs special defaults (two sources like `comparison`, or annotations like `technical`), add them in `ImageStudio.create()` and `update()` in `apps/server/src/image/studio.ts`.
6. Add it to the "all four presets fit" test in `apps/server/src/image.test.ts`, which renders every preset at every canvas size (X 1200×675, LinkedIn 1200×627, square 1080×1080, portrait 1080×1350) and checks fidelity.

Keep the screenshot element free of CSS filters, blend modes and overlapping text: the fidelity check rejects changes to the screenshot.

## Add a video style

A video style is a stylesheet plus style-specific branches in the HTML generator.

1. Create `packages/templates/video/<style>/styles.css`. Animate with CSS or the Web Animations API only; GSAP is rejected by the validator and by the license policy (see [licenses.md](licenses.md)). Use the bundled fonts (`IBM Plex Sans` 400/600, `IBM Plex Mono` 400); BIP stages them next to every render.
2. Add `<style>` to the `style` enum of the video composition schema in `packages/shared/src/index.ts`, and to `z.enum(["clean", "technical"])` in `apps/server/src/video/routes.ts`.
3. Add style-specific markup, if any, in `apps/server/src/video/build.ts` (for example `technical` switches captions to mono and adds a callout on stills) and in `VideoStudio` in `apps/server/src/video/studio.ts` (where `technical` adds terminal and annotated-still scenes).
4. Add an `<option>` in `apps/web/src/features/video/Studio.tsx`.
5. If agents should know the style, describe it in `agent-skills/video-editor.md`.
6. Extend `apps/server/src/video.test.ts`; a render needs FFmpeg and Chromium, as the existing tests do.

Compositions may contain only `composition.json`, `index.html`, `styles.css` and `motion.js`, with no external URLs.

## Add a post action

Post actions (Regenerate, Shorten, Expand, Tone, Adapt, Follow-up) are buttons in the draft editor that send an instruction to the same agent task, `post.edit`.

1. In `apps/web/src/features/studio/Stories.tsx`, add a button next to the others that calls `edit("<instruction>")`. `edit(text, extra)` posts to `/api/projects/:id/stories/:storyId/posts/:postId/edit` with `{ provider, instruction, ...extra }`.
2. `extra` accepts `followUp: true` (write the result as a new follow-up post) or `sourcePostId` (adapt from another post). Anything else is rejected by the route's strict schema in `apps/server/src/content-routes.ts`.
3. The instruction is inserted into the `post.edit` prompt in `Content.run()` (`apps/server/src/content.ts`), together with the current text and the context bundle. If the action needs different guidance, prefer a short, explicit instruction string; for a general rule, update `agent-skills/post-writer.md`.
4. To make the fake agent return something specific in tests, add a branch to the `TASK: post.edit` case in `tests/fixtures/agents/fake.mjs` (it already switches on "Shorten").

Every result becomes a new revision that can be restored, and clears approval.

## Add a publishing provider

There is no provider interface for platforms yet; `x` and `linkedin` are handled with explicit branches. A new platform touches:

- **Types:** the `platform` enum and `PlatformId` in `packages/shared/src/index.ts`, plus the copies in `apps/server/src/bip/store.ts`, `content-routes.ts` and `publishing/routes.ts`.
- **Drafting:** the X + LinkedIn draft schema and prompt in `apps/server/src/content.ts`, `agent-skills/post-writer.md`, and character limits in `packages/shared/src/index.ts` and `Stories.tsx`.
- **Assisted publishing:** the share URL and the allowed hosts for pasted post links in `packages/shared/src/index.ts`, and the publish sheet in `apps/web/src/features/studio/Publish.tsx`.
- **API client:** a class like `XApi` or `LinkedInApi` in `apps/server/src/publishing/platforms.ts` with `authorizeUrl`, `exchange`, `refresh` (if tokens refresh), `revoke`, `profile`, `upload` and `createPost`, plus entries in `SCOPES`, `PLATFORM_NAME` and `endpoints()` (with a `BIP_<PLATFORM>_*_BASE` override so tests can use a mock). Send every request through `send()` so retries, rate limits and token scrubbing apply, and throw `PlatformError` with a message that says what to do.
- **Accounts and publishing:** the client factory and platform branches in `publishing/accounts.ts`; media limits, how parts are joined, and the post URL in `publishing/publisher.ts`. Keep the rules: re-check `approvedRevisionId === currentRevisionId` before every create call, persist returned ids before anything else, and never retry a create call automatically after an ambiguous failure.
- **UI:** the setup guide (redirect URI, scopes, developer portal link) in `apps/web/src/features/settings/Accounts.tsx`, and `DirectPublish.tsx`.
- **Tests:** a mock in `tests/mocks/platforms.ts`, unit tests in `apps/server/src/publishing.test.ts`, and an e2e flow like `tests/e2e/m5.spec.ts`. Tests must never call the real platform.

Use the platform's official API with the user's own developer app. Don't automate the platform's website.
