# Milestone M6: Polish and open-source release prep

You are preparing Build in Public (BIP) for its first public release, on top of M1–M5. Read first: `docs/plan.md` (§P, M6), `docs/design.md`, `docs/architecture.md`, `docs/milestones/*.md`.

Worktree/branch: see "Environment" at the end. **Do not commit or push. Do not change the GitHub repo's visibility** (the maintainer does that).

## 1. Install experience
- `pnpm setup` (root script, wraps `bip setup`): an interactive-when-TTY, non-interactive-otherwise checklist that verifies Node ≥ 22, git, ffmpeg/ffprobe, Playwright Chromium (offering to install it with `npx playwright install chromium`, asking first), HyperFrames runtime, and claude/codex presence and sign-in, with copy-pasteable fix commands per OS family (Debian/Ubuntu, Fedora, Arch, macOS/Homebrew). It writes the default config and prints the start command. Exit code 0 when the minimum (Node, git, ffmpeg, Chromium, at least one agent) is met.
- **pnpm bootstrap:** document both `corepack enable` and `npx pnpm@<pinned>`; the README's quickstart uses the one that works on stock Ubuntu (`npx --yes pnpm@10.34.9 …`).
- First-run onboarding in the UI (shown when no projects are tracked): 3 steps (pick agents → add a folder → pick repos), each skippable, and reusing the existing dialogs.
- `bip start --port`, `--no-open`, and `--data-dir` flags documented in `bip --help`.

## 2. Docs (concise, accurate, no marketing fluff)
- `README.md`: one-paragraph pitch; a GIF/screenshot (take real ones with Playwright against a demo project and store them in `docs/media/`, < 2 MB total); quickstart (5 commands); "How it works" (projects → stories → drafts/images/videos → publish); requirements; the privacy/local-first statement (what leaves the machine: agent CLI calls via your own accounts; social API calls only if you connect accounts); a `.bip/` data warning (`git clean -fdx`); links to the docs.
- `docs/architecture.md`: update to the final state (diagram, modules, data layout, job runner, agent isolation, render origins).
- `docs/security.md`: the threat model and mitigations (localhost auth, Host/Origin checks, path allowlist, agent isolation and why cwd never sits in a repo, composition validation, render sandbox, secrets handling, publishing approval), plus how to report a vulnerability.
- `docs/agents.md`: how Claude Code and Codex are used, the exact flags, auth expectations (your own subscription or API key; BIP never touches credentials), the usage notes, and how to add a new provider (the interface + an example skeleton).
- `docs/extending.md`: adding an image preset, a video style, a post action, and a publishing provider.
- `CONTRIBUTING.md` (setup, scripts, test layers, fake agents, commit style), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`.
- `docs/licenses.md`: generated table of direct dependencies + licences (script `pnpm licenses:report` using `pnpm licenses list --json`); call out non-MIT ones (HyperFrames Apache-2.0, Playwright Apache-2.0, FFmpeg as a system binary (LGPL/GPL, not bundled), IBM Plex OFL-1.1) and confirm that **no GSAP and no Remotion** are present (add a CI check that fails if either appears in the lockfile).

## 3. Demo project
- `examples/demo-project/`: a script `pnpm demo:create` that generates a small throwaway git repo under a temp/chosen dir with ~12 realistic commits across 4 days (a tiny static web app with a feature worth showing) plus a local static server command, so new users can try every workflow (stories, image capture, video record) without touching their own repos. Use it for the README screenshots.

## 4. CI (GitHub Actions, `.github/workflows/ci.yml`)
- Ubuntu job: pnpm install (cache), typecheck, unit tests, build, Playwright e2e with fake agents (install Chromium + ffmpeg via apt), the licence guard, and `bip doctor --ci` (skips agent sign-in checks). Upload Playwright traces on failure.
- Keep it under ~15 min; split e2e into its own job if needed.

## 5. Quality pass
- Run every e2e flow and fix flakiness (no fixed sleeps; use web-first assertions).
- Accessibility pass on main screens: keyboard-only navigation through Projects → story → publish sheet; visible focus; labels; colour contrast ≥ 4.5:1 in both themes (add an axe-core check in e2e for 4 key pages, failing only on serious/critical).
- Bundle: code-split the studios (lazy routes) to remove the >500 kB chunk warning.
- Error copy audit: every user-facing error says what happened + what to do (per design.md writing rules).
- `bip doctor` and the Settings → About page show versions of BIP, HyperFrames, Playwright, claude, codex.

## 6. Cross-platform notes
- `docs/platforms.md`: Linux is supported; macOS is expected to work but untested (list known differences: keychain = Keychain Access; `open` vs `xdg-open`); Windows unsupported for now (paths, signals, process groups). Guard Linux-only code paths behind small helpers.

## Deliverable
`M6-RESULT.md` at the repo root, ≤ 50 lines, including a "Release checklist for the maintainer" (make the repo public, add topics, cut tag v1.0.0, etc.).
