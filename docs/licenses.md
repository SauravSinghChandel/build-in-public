# Licences

Build in Public is released under the [MIT licence](../LICENSE).

This page lists the significant direct dependencies. Each licence was read from the installed package's `package.json` in `node_modules` (versions as resolved by `pnpm-lock.yaml` at the time of writing). `npx --yes pnpm@10.34.9 licenses:report` regenerates the full table, including transitive dependencies, from `pnpm licenses list --json`.

## Runtime dependencies

| Package | Version | Licence | Used by | Purpose |
|---|---|---|---|---|
| hono | 4.13.16 | MIT | server | HTTP framework |
| @hono/node-server | 1.19.18 | MIT | server | Node adapter for Hono |
| better-sqlite3 | 12.11.1 | MIT | server | SQLite (`app.db`) |
| zod | 4.6.7 | MIT | server, web, shared | Schemas and validation |
| @napi-rs/keyring | 2.1.2 | MIT | server | OS keychain access |
| playwright | 1.64.1 | **Apache-2.0** | server | Chromium for capture and rendering |
| hyperframes | 0.9.13 | **Apache-2.0** | server | Video lint, frame snapshots and rendering |
| pixelmatch | 8.0.0 | ISC | server | Screenshot fidelity check |
| pngjs | 7.0.0 | MIT | server | PNG decoding for the fidelity check |
| react, react-dom | 19.3.1 | MIT | web | UI |
| @tanstack/react-query | 5.105.3 | MIT | web | Data fetching and caching |
| @tanstack/react-router | 1.170.46 | MIT | web | Routing |
| radix-ui | 1.8.1 | MIT | web | Dialogs, menus, switches, tooltips |
| cmdk | 1.1.1 | MIT | web | Command palette |
| sonner | 2.0.8 | MIT | web | Toasts |
| lucide-react | 0.468.0 | ISC | web | Icons |
| class-variance-authority | 0.7.1 | **Apache-2.0** | web | Component variants |
| clsx | 2.1.1 | MIT | web | Class names |
| tailwind-merge | 3.7.0 | MIT | web | Class merging |
| @fontsource/ibm-plex-sans | 5.3.0 | **OFL-1.1** | web | UI font (self-hosted) |
| @fontsource/ibm-plex-mono | 5.3.0 | **OFL-1.1** | web | Monospace font (self-hosted) |

## Development dependencies

| Package | Version | Licence |
|---|---|---|
| typescript | 5.9.3 | **Apache-2.0** |
| vite | 7.3.7 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| tailwindcss, @tailwindcss/vite | 4.3.4 | MIT |
| vitest | 3.2.7 | MIT |
| @playwright/test | 1.64.1 | **Apache-2.0** |
| tsx | 4.23.15 | MIT |
| concurrently | 9.2.5 | MIT |
| @types/node, @types/react, @types/react-dom, @types/better-sqlite3, @types/pngjs | various | MIT |

## Non-MIT components to know about

- **Playwright** (Apache-2.0). Its browser download (Chromium) is fetched by `playwright install chromium` into Playwright's cache; it is not part of this repository.
- **HyperFrames** (Apache-2.0), the video engine, pinned at 0.9.13.
- **class-variance-authority** and **TypeScript** (Apache-2.0).
- **IBM Plex** fonts (SIL Open Font License 1.1). Besides the `@fontsource` packages, WOFF2 copies are bundled in `packages/templates/image/` and `packages/templates/video/fonts/`, each with its `OFL.txt`.
- **FFmpeg** is a system binary that you install yourself. BIP calls `ffmpeg` and `ffprobe` as separate processes and does not bundle or link them. FFmpeg is LGPL-2.1+ or GPL-2+, depending on how your distribution built it (builds with `libx264`, which BIP uses for H.264, are GPL).
- **Git**, **tar**, **Claude Code** and **Codex CLI** are also external programs you install, under their own terms.

Apache-2.0 and OFL-1.1 are compatible with distributing BIP under MIT; keep their licence and notice files when redistributing.

## No GSAP, no Remotion

Neither GSAP nor Remotion is a dependency of BIP: no `gsap`, `remotion` or `@remotion/*` package appears in `pnpm-lock.yaml`.

- **Remotion** was evaluated in the M0 video bake-off. HyperFrames was chosen: it rendered faster (36 s vs 54 s), installed smaller (145 MB vs 561 MB), was frame-deterministic in our test, and is Apache-2.0. Remotion is source-available and requires a paid company licence above a small team size, which would put a licensing obligation on BIP users at companies.
- **GSAP** is free of charge but ships under its own "standard" licence (https://gsap.com/standard-license), not an open-source one, and that licence restricts use in no-code visual animation builders, which is close to what Video Studio is. BIP's video templates animate with CSS and the Web Animations API, the video validator rejects any composition that mentions `gsap` or `__timelines`, and `agent-skills/video-editor.md` tells agents not to use it.

One caveat: the `hyperframes` npm package ships its own vendored copy of GSAP in `dist/vendor/npm/gsap@3.15.0/`, used by HyperFrames' studio and GSAP adapter. BIP never loads it: its compositions are GSAP-free and the validator rejects GSAP references. A lockfile check does not see this copy because it is not a separate package.
