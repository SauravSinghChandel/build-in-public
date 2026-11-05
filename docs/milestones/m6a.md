# M6a result: setup, demo, CI, quality pass

## Install experience
- `bip setup` (`apps/server/src/setup.ts`): checks Node ≥ 22, git, ffmpeg/ffprobe, Playwright Chromium (asks to install it when on a TTY; `--yes` installs without asking), the HyperFrames runtime, and whether claude/codex are installed and signed in. Prints fix commands for Debian/Ubuntu, Fedora, Arch, and macOS, writes the default config, and prints the start command. It exits 0 only when Node, git, ffmpeg, Chromium and at least one agent are all ready.
- The root script is **`pnpm run bootstrap`**. It can't be called `setup` because `pnpm setup` is a pnpm built-in. On stock Ubuntu use `npx --yes pnpm@10.34.9 run bootstrap`.
- `bip --help` / `-v`. `bip start --port <n> --no-open --data-dir <path>`; `--data-dir` sets BIP_HOME, so config.json moves there too. `bip doctor --ci` skips agent checks. Doctor now prints versions of BIP, HyperFrames, Playwright, claude and codex.
- First-run onboarding (`features/projects/Onboarding.tsx`) appears on Projects while nothing is tracked. It has 3 skippable steps: pick agents (saved as `bip-default-agent`; AgentPicker uses it when a project has no last agent), add a folder, and pick repositories. Steps 2 and 3 reuse the `AddProjects` dialog, which gained `initialMode` and `onStage` props.
- Settings → About lists tool versions from the new `GET /api/versions`.

## Demo project
- `pnpm demo:create [dir] [--port 4321]` creates `<dir>/shiplog` (default dir: a new temp folder): a static "Shiplog" app with 12 commits over 4 days ending today, plus a zero-dependency `serve.mjs`. It has a `#go` button, which matches the fake agent's video steps.

## CI and licences
- `.github/workflows/ci.yml` runs two jobs on Ubuntu 24.04 with Node 22 and the pnpm cache. **check:** apt ffmpeg, `install --frozen-lockfile`, licence guard, Chromium `--with-deps`, typecheck, unit tests, build, `doctor --ci`. **e2e:** the same setup, then `test:e2e` with fake agents, uploading `test-results/` traces on failure. The YAML parses, and every command it runs works locally.
- `pnpm licences:guard` (`scripts/licence-guard.mjs`) fails if gsap or remotion appears in pnpm-lock.yaml. It only **warns** (as a GitHub `::warning::`) about the GSAP 3.15.0 copy bundled inside hyperframes' dist.
- `pnpm licenses:report [out]` writes `docs/licenses.md` from `pnpm licenses list --json -r`. I didn't run it on docs/ because that file belongs to the docs engineer.

## Quality pass
- Removed both `waitForTimeout(350)` sleeps from m2.spec. The test now waits until the agent session id is saved in app.db (read-only better-sqlite3).
- New `tests/e2e/a11y.spec.ts` (uses the demo repo) runs axe (WCAG 2.1 A/AA, fails only on serious or critical) on 4 pages: Projects (onboarding, dark and light), Overview, Story editor plus the publish sheet, and Settings (dark and light). It also checks keyboard-only navigation from Projects to Overview, a visible focus ring, and that focus stays inside the publish sheet.
- **Contrast fix:** light-theme `--signal` changed from `#B7801A` to `#8F6210`. The old colour was 3.4:1 with white text, which fails 4.5:1. **docs/design.md still lists `#B7801A` and should be updated.**
- Bundle: Workspace and ContentPage are now lazy routes, and react, tanstack and zod are split into vendor chunks. The largest chunk is 245 kB and the >500 kB warning is gone.
- Error copy: server and web errors now say what happened and what to do. The generic "Check the input and folder permissions" hint is now only added to schema-validation errors.
- Agent workspaces: JobRunner deletes `<appdata>/workspaces/<jobId>` when a job succeeds or is cancelled. Failed and interrupted workspaces are kept for 7 days, and `prune()` removes them when the server starts, along with orphaned workspaces.

## Tests
- New `apps/server/src/m6.test.ts` covers OS detection and fixes, the setup minimum, versions, the licence guard, the demo repo, and workspace cleanup.
- typecheck, test (131/131), build and test:e2e (6/6) pass, and the build has no chunk warning. `m5.test.ts` "uses no placeholder copy" timed out under load in 2 of 3 full runs. The cause: its captions job waits behind about 6 HyperFrames preview renders while `video.test.ts` renders at the same time. It passes on its own. This was here before M6 and isn't caused by these changes.

## Notes
- `@axe-core/playwright` is MPL-2.0 and dev-only.
- `pnpm licenses list` shows two `@hono/node-server` versions; one comes in transitively.

## Reviewer follow-up
- Fixed the flaky "no placeholder copy" test at the root: the job runner now has a render lane (1 slot: video.preview/contact/final) and a work lane (2 slots), so agent jobs never queue behind renders. A new unit test covers it; the full suite passed twice in a row (132 tests).
