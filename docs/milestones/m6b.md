# M6b result: release docs (§2, §6)

Files: `README.md`, `docs/architecture.md` (rewritten to final state), `docs/security.md`, `docs/agents.md`, `docs/extending.md`, `docs/platforms.md`, `docs/licenses.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, verbatim from EthicalSource's repo), `SECURITY.md`, `docs/media/{projects,overview,story,image-studio}.webp` (148 KB total). No application code changed; nothing committed.

How facts were verified:
- Flags, env vars, paths, limits: read from code (`agents/index.ts` buildArgs, `config.ts`, `paths.ts`, `app.ts`, `cli.ts`, `doctor.ts`, `image/validate.ts`, `video/validate.ts`, `image/render.ts`, `publishing/*`, `agents/context.ts`), plus milestone notes for behaviour I didn't re-run.
- Ran: build, `bip doctor` (all pass), `bip --help` usage, single-file vitest, `pnpm help setup`, `corepack enable` (EACCES on /usr/bin), `playwright --version` (1.64.1).
- Licences: read from each installed package.json in node_modules; lockfile has no gsap/remotion entries.
- Screenshots: real app (production build, temp BIP_HOME, XDG_CONFIG_HOME=/tmp/bip-m6b/config, fake agent CLI) on a 10-commit demo repo in /tmp/bip-m6b/demo; `.git/info/exclude` and clean `git status` confirmed there.

Findings for the coordinator / M6a:
- `pnpm setup` is pnpm's built-in command; the root script must be invoked as `pnpm run setup`. README quickstart currently uses `exec playwright install chromium` + `run doctor`; swap in `run setup` once M6a lands.
- `bip start --port/--no-open/--data-dir` and `pnpm licenses:report` don't exist in this branch; docs only reference `licenses:report` (in licenses.md). Update the CLI table in architecture.md when the flags merge.
- HyperFrames 0.9.13 vendors GSAP 3.15.0 in `dist/vendor/` (not a lockfile package, so a lockfile guard won't see it). Documented in licenses.md; BIP never loads it.
- HyperFrames has PostHog telemetry on by default; BIP sets `HYPERFRAMES_NO_TELEMETRY=1` on every call (verified), so "no telemetry" holds.
- `private.md` lines are sent to agents as a "never mention" list; README/security say so.
- Agent cost is stored in `agent_runs.cost_usd` but not shown in the UI (plan said it would be).
- All Chromium launches use `chromiumSandbox: false` (Playwright's default); documented as a limitation.
- Post-writing agent workspaces in `<data>/workspaces/` are not deleted after success (image/video ones are).
- `CODE_OF_CONDUCT.md` and `SECURITY.md` use sauravca527@gmail.com as contact; maintainer should confirm, and enable GitHub private vulnerability reporting.

Not verified: macOS/Windows behaviour (docs say untested), live X/LinkedIn calls, real Claude/Codex runs, Fedora/Arch package names beyond general knowledge.
