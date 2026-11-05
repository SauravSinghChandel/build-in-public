# Contributing

Thanks for helping. Bug reports, fixes, docs and new presets or styles are all welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md).

## Setup

You need Linux (macOS may work, see [docs/platforms.md](docs/platforms.md)), Node 22 or later, Git, and FFmpeg with `ffprobe`. You don't need Claude Code or Codex to develop or run the tests.

```sh
git clone https://github.com/SauravSinghChandel/build-in-public.git && cd build-in-public
npx --yes pnpm@10.34.9 install
npx --yes pnpm@10.34.9 exec playwright install chromium
npx --yes pnpm@10.34.9 run doctor
```

The examples use `npx --yes pnpm@10.34.9`; if you have corepack working, `corepack enable` and plain `pnpm` are equivalent.

For development, `npx --yes pnpm@10.34.9 dev` runs the API on 127.0.0.1:4310 (with `tsx watch`) and Vite on 127.0.0.1:5173. Open the token URL printed in the terminal; it redirects to Vite after setting the session cookie.

Use a separate data directory so development doesn't touch your real projects list:

```sh
BIP_HOME=/tmp/bip-dev npx --yes pnpm@10.34.9 dev
```

## Scripts

Run them as `npx --yes pnpm@10.34.9 <script>`:

| Script | What it does |
|---|---|
| `install` | Installs dependencies (and builds `better-sqlite3`'s native module) |
| `dev` | Builds `@bip/shared`, then runs the server and Vite in watch mode |
| `build` | Builds shared, server and web |
| `start` | `build`, then `bip start` on port 4310 |
| `run doctor` | Builds and runs `bip doctor`. Use `run`: `pnpm doctor` is pnpm's own command |
| `run bootstrap` | First-time setup checks (`bip setup`) with fix commands |
| `demo:create [dir]` | Generate the demo repo used for screenshots and manual testing |
| `licences:guard` | Fails if GSAP or Remotion enter the lockfile; warns about HyperFrames' vendored GSAP |
| `licenses:report [out]` | Regenerate the dependency licence table |
| `typecheck` | Type-checks every package and the tests |
| `test` | Unit and integration tests (Vitest) |
| `test:e2e` | `build`, then the Playwright end-to-end tests |

Unit tests import `@bip/shared` from its build output, so run `build` or `typecheck` once after cloning and after changing `packages/shared`.

## Tests

- **Unit and integration** (`apps/**/*.test.ts`, Vitest): Git parsing, the `.bip/` store, migrations, path checks, agent stream parsing with recorded fixtures, image and video pipelines, publishing against mocks. They create throwaway repositories in the OS temp directory. Video tests need FFmpeg and Chromium.
- **End to end** (`tests/e2e/*.spec.ts`, Playwright): each spec starts the compiled server on its own port (14310–14315) with a temporary `HOME` and `BIP_HOME`, drives the UI in headless Chromium, and cleans up.
- **Fake agents:** tests never call real models. `tests/fixtures/agents/fake.mjs` stands in for both `claude` and `codex` (point `BIP_CLAUDE_BIN` and `BIP_CODEX_BIN` at it). It replays JSONL streams recorded from the real CLIs in the M0 spike and returns task-specific structured output. `BIP_FAKE_MODE=invalid|nonzero|slow` exercises failure and cancellation. See `tests/fixtures/agents/README.md`.
- **Fake platforms:** `tests/mocks/platforms.ts` implements the X and LinkedIn OAuth, media and post endpoints the app uses; tests point `BIP_X_*` and `BIP_LINKEDIN_*` base URLs at it.

Run a single file:

```sh
npx --yes pnpm@10.34.9 exec vitest run apps/server/src/m2.test.ts
npx --yes pnpm@10.34.9 build && npx --yes pnpm@10.34.9 exec playwright test tests/e2e/m2.spec.ts
```

If Chromium crashes at start-up in a sandboxed environment because `~/.config` is read-only, set `XDG_CONFIG_HOME` to a writable folder.

Tests must never read, scan or modify the developer's own repositories, and must never call Claude, Codex, X or LinkedIn. Changes to agent adapters should come with a recorded-stream fixture. Real-agent and real-platform checks are done by hand by a reviewer.

## Making changes

- Keep changes focused; one topic per pull request.
- Add or update tests for behaviour changes, and update the docs in `docs/` when you change a command, flag, path, environment variable or security property.
- Before opening a pull request, run `typecheck`, `test` and `test:e2e`.
- User-facing text uses sentence case and says what happened and what to do next (see `docs/design.md`).
- Don't add GSAP, Remotion or AGPL-licensed code; see [docs/licenses.md](docs/licenses.md).
- Don't weaken the agent isolation rules in [docs/agents.md](docs/agents.md) or the checks in [docs/security.md](docs/security.md) without discussing it in an issue first.
- How to add presets, styles, post actions and platforms: [docs/extending.md](docs/extending.md).

## Commit messages

Write a short imperative subject in sentence case, without a trailing period, for example `Fix codex strict-schema rejection of optional fields`. Add a body when the reason isn't obvious from the diff.

## Licence

By contributing you agree that your contributions are licensed under the [MIT licence](LICENSE).
