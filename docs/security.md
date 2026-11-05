# Security

BIP is a single-user tool that runs on your machine. This page describes what it protects, against whom, and how. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is at stake

- Your source code and the private notes in each project's `.bip/private.md`.
- Your X and LinkedIn tokens, if you connect accounts, and with them the ability to post as you.
- Your Claude and Codex accounts, which BIP drives through their CLIs.
- Your files outside the tracked repositories.

## Threats considered

1. **Web pages in your browser** that try to reach the local server (CSRF, DNS rebinding) or read its responses.
2. **Untrusted repositories.** A tracked repository may contain agent hooks, MCP server configs, or text written to steer an agent (prompt injection).
3. **Agent output.** An agent may produce compositions with scripts, external resources, or files outside its folder, by mistake or because a repository told it to.
4. **Captured web pages.** The page you capture runs its own JavaScript in BIP's headless Chromium.
5. **Secrets in content.** A draft, diff or screenshot can contain a credential or something you listed as private.
6. **Accidental publishing.** A post going out that you didn't approve, or a different version from the one you approved.

Out of scope: other processes running as your user (they can already read your files and the app's data), a compromised `claude`, `codex`, `git` or `ffmpeg` binary, and multi-user machines where others can reach 127.0.0.1 ports.

## Mitigations

### Local server and authentication

- The server listens on 127.0.0.1 only (default port 4310, `BIP_PORT` to change it).
- A new random 32-byte session token is generated at each start and printed as `http://127.0.0.1:<port>/?token=…`. Opening that URL sets an HttpOnly, `SameSite=Strict` cookie scoped to `/api` and redirects, so the token leaves the address bar. Tokens are compared in constant time.
- Every `/api` request needs the cookie. The only unauthenticated routes are the static UI, the token exchange and the OAuth callbacks (`/oauth/<platform>/callback`).
- Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. Requests other than GET/HEAD/OPTIONS that carry an `Origin` must come from the app's own origin.
- Responses set `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`; API responses are `Cache-Control: no-store`.
- `BIP_DEV_NO_AUTH=1` disables the cookie check, and only when `NODE_ENV=development`.

### File system

- Folder autocomplete only lists folders under your home directory.
- Folders you add explicitly become allowed scan roots. Tracked repositories can be read; BIP writes only to their `.bip/` folder, its own data directory and its cache.
- All user-supplied paths are resolved with `realpath` and must stay inside an allowed root; `..` segments are rejected. Paths inside `.bip/` reject symlinks.
- Git, FFmpeg, tar, HyperFrames and the agent CLIs are run with `execFile`/`spawn` and argument arrays, never through a shell. Git commands have a 10-second timeout and bounded output.
- This does not protect against another process swapping paths between the check and the use.

### Agent isolation

- Agents never run with a repository as their working directory. A `claude -p` started inside a repository runs that repository's hooks and MCP servers; BIP's M0 spike demonstrated this with a canary, and showed the isolated pattern below blocks it for both CLIs.
- Each run gets a fresh workspace under BIP's data directory. The image and video studios check that the workspace is outside every tracked repository before starting.
- Claude runs with `--setting-sources user --strict-mcp-config --permission-mode dontAsk` and an explicit tool list: `Read,Grep,Glob`, plus `Edit,Write` only for image and video edits. Codex runs with `-s read-only`, or `-s workspace-write` for edits.
- Writing tasks receive a prepared, redacted context bundle instead of the repository. Only the project summary task can read the repository, read-only, through `--add-dir`. Prompts label repository content as untrusted data.
- Edits happen on a copy of the composition. Source images are read-only copies, checked by hash before anything is copied back.
- Generated capture steps are shown to you and run only after you approve them.

Details and exact flags: [agents.md](agents.md).

### Composition validation

Before an agent's edit is accepted:

- **Images:** only `.html`, `.css`, `.json`, `.svg` and `.woff2` files of at most 1 MB; no symlinks, scripts, inline event handlers, `iframe`/`object`/`embed`/`base` elements, `@import`, `javascript:` or external URLs. BIP injects its own slot loader at render time. A fidelity check compares the screenshot region with the source (CSS lint plus a pixel diff with a 3% limit) so the screenshot itself isn't altered.
- **Videos:** only `composition.json`, `index.html`, `styles.css` and an optional `motion.js`; no symlinks, external URLs, unsafe resources or GSAP; then HyperFrames `lint --json` runs on a disposable copy.
- Protected metadata and source hashes must be unchanged. A failed check keeps the previous revision.

### Render sandbox

- Image compositions are served from a second HTTP listener on a random 127.0.0.1 port. Each revision snapshot gets a random 48-hex-character capability path. This listener never reads or sets cookies, checks `Host`, and sends a restrictive CSP (`default-src 'self' data: blob:`, no frames, objects or `base`).
- The renderer's Chromium blocks every request outside the render origin, and blocks service workers.
- In the UI, previews load in an iframe with `sandbox="allow-scripts"` (no same-origin access) and the `credentialless` attribute.
- Video renders get an injected CSP that limits resources to the render origin and disables connections, frames, forms and `base`.
- Capture runs in a fresh browser context with no BIP cookies.
- Chromium runs without its OS-level sandbox (`chromiumSandbox: false`, Playwright's default). Isolation relies on the separate origin, request blocking and validation above.

### Secrets

- **Your agent credentials:** BIP never reads, stores or forwards them. You sign in with the CLIs yourself.
- **Social tokens and the app client secret:** stored in the OS keychain through `@napi-rs/keyring` (service `build-in-public`). If the keychain isn't usable, BIP falls back to an AES-256-GCM file `<data>/secrets.enc` with a 0600 key file `<data>/secrets.key` next to it, and Settings warns that this only protects against casual reading. `BIP_SECRET_STORE=keychain|file` forces one. SQLite holds only client ids, handles, scopes, expiry and a keychain reference.
- Tokens are never logged or given to agents. Error text from X and LinkedIn passes through a scrubber that removes token values and bearer patterns before it is stored or shown.
- **Secrets in content:** context bundles are redacted with secret patterns (AWS and Google keys, GitHub, Slack and Stripe tokens, `sk-` keys, private keys, JWTs, `.env` values). Approval is blocked while a draft matches a secret pattern or contains a term from `private.md` that you haven't acknowledged. This is pattern matching: it can miss secrets and cannot check facts.
- `private.md` is ignored by Git, not encrypted. Its lines are sent to the agent as a "never mention" list.
- `run doctor` warns when a tracked repository has a `Dockerfile` without `.bip/` in `.dockerignore`, since `.git/info/exclude` does not apply to Docker build contexts.

### Publishing approval

- Nothing is published without an approval bound to an exact revision. Approval is rejected while there are secret matches, unchecked "claims to verify", or unacknowledged private-term warnings.
- Any edit to text or media clears the approval, and unschedules a scheduled post.
- Direct publishing checks `approvedRevisionId === currentRevisionId` (and that it matches the job's revision) when the job starts and again right before every create-post call.
- "Post now" shows a confirmation with the exact parts, media and account.
- Create-post calls are never retried automatically after a timeout, network error or 5xx. The post is marked "May have posted" until you paste its link or choose "Retry anyway". Returned post ids are saved before anything else, so a retry never re-sends a part that already went out.
- Scheduled posts more than 2 minutes late become Overdue and are never posted automatically.
- OAuth `state` is 32 random bytes, single-use, expires after 10 minutes, and is bound to your browser by a cookie scoped to `/oauth/<platform>`. X uses PKCE (S256).
- BIP does not automate the X or LinkedIn websites. Assisted publishing only opens their share pages.

## Known limitations

- The session token is printed to the terminal; anyone who can read your terminal output can use it until the server restarts.
- The fallback secret file keeps its key next to it.
- Secret and private-term checks are best-effort regular expressions.
- Locks and backups are per-file safeguards, not transactions; see [architecture.md](architecture.md).
- The keychain probe in Settings → Accounts is synchronous; a locked desktop keyring may prompt or block.
