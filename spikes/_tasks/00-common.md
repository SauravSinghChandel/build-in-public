# Rules for every M0 spike worker

You are running one throwaway proof-of-concept ("spike") for **Build in Public (BIP)**, a local-first web app that turns a developer's recent Git work into X/LinkedIn posts, polished images, and edited demo videos, using the user's installed `claude` and `codex` CLIs. Read `docs/plan.md` (sections H–M) for context. Do not build the app itself.

Hard rules:
- Repo root: `/home/justbuster/projects/build-in-public`. Write **only** inside your own spike folder `spikes/<name>/` (named in your task) and `/tmp/bip-spike-<name>/`. Never edit `docs/`, other spike folders, or anything else in the repo.
- Never modify other repositories. `~/projects/portfolio` is **read-only** input: copy what you need into your spike folder or `/tmp`.
- No `git commit`, `git push`, branch changes, or `git config` changes in this repo. (Creating scratch git repos under `/tmp/bip-spike-<name>/` is fine.)
- Node 22 is installed; `pnpm` is not. Use a local `package.json` + `npm install` inside your spike folder. Plain `.mjs` or `.ts` run with `node --experimental-strip-types` are both fine. Keep `node_modules` inside your spike folder.
- FFmpeg 8 is installed. Playwright browsers already exist in `~/.cache/ms-playwright` (chromium-1248); reuse them if your Playwright version matches, else `npx playwright install chromium`. If Chromium fails to launch because of the sandbox, launch with `chromiumSandbox: false` (content is local and trusted).
- If you call the `claude` CLI: at most 8 calls in total, always `claude -p`, and pass `--max-budget-usd 1`. If you call the `codex` CLI from inside your run: always `codex exec ... < /dev/null`.
- Never read, print, or copy credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`, keychains).
- Time-box yourself. If an approach fails twice for the same reason, write down why and move on to the next part. A clear negative result is a valid outcome.

Deliverable (required, even on failure): `spikes/<name>/RESULT.md`, at most ~60 lines:
1. One-line verdict (GO / GO-with-caveats / NO-GO).
2. A table of each acceptance check → PASS/FAIL + evidence (numbers, file paths).
3. Gotchas, surprises, and exact CLI flags/versions that mattered.
4. Recommendation for the real implementation (concrete, short).
5. "How to re-run": the exact commands.

Keep generated outputs (images, videos, logs) in `spikes/<name>/out/`. Add a `spikes/<name>/.gitignore` that ignores `node_modules/` and any file over ~20 MB.
