# Milestone M5: Direct publishing + scheduling (optional by design)

You are implementing milestone **M5** of Build in Public (BIP) on top of M1–M4. Read first: `docs/plan.md` (§K, §L, M5), `docs/design.md`, `docs/architecture.md`, `docs/milestones/*.md`. Assisted publishing (M2) stays the default and must keep working with no accounts connected.

Worktree/branch: see "Environment" at the end. **Do not commit or push.** Don't edit `docs/plan.md` or `spikes/`. **Never make real calls to X or LinkedIn in tests**: use a local mock server for both APIs (base URLs are configurable).

## 1. Accounts (user's own developer apps)
- Settings → Accounts. For each platform there's a short setup guide (create your own developer app; the exact redirect URI to register: `http://127.0.0.1:<port>/oauth/<platform>/callback`; required scopes), fields for Client ID (and Client Secret where the platform requires one), and "Connect".
  - X: OAuth 2.0 Authorization Code with **PKCE**; scopes `tweet.read tweet.write users.read media.write offline.access`. The guide notes the pay-per-use pricing (≈ $0.015 per post; posts with a URL cost far more, reportedly ≈ $0.20) and links to X's pricing page. Prices aren't hard-coded anywhere else.
  - LinkedIn: OAuth 2.0 Authorization Code; products "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn"; scopes `openid profile w_member_social`. Get the person URN from `/v2/userinfo` (`sub`). Tokens last ~60 days; store `expires_at` and show "Reconnect by <date>".
- OAuth `state` is random, single-use, and expires after 10 min. Callback routes are the only unauthenticated routes and must validate `state` + PKCE verifier.
- **Secrets** (client secret, access/refresh tokens) live in the OS keychain via `@napi-rs/keyring`, under service `build-in-public` and account `<platform>:<accountId>:<kind>`. Fallback when no keychain is available (headless Linux): an AES-256-GCM-encrypted file at `<appdata>/secrets.enc`, with a key file (mode 0600) and a clear warning in Settings. The `accounts` table stores only metadata + `keychain_ref`. Tokens never reach logs, agent prompts, or API responses.
- Disconnect = revoke (when the platform supports it) + delete secrets + delete the account row.

## 2. Publishing
- Publish jobs (`type: 'publish'`, `resource_key: post:<id>`) via the M2 job runner, with **idempotency**: store the external id as soon as the API returns it, and never re-send a post that has an `externalId`.
- A job runs **only** when `post.approvedRevisionId === post.currentRevisionId` (re-checked inside the job, right before the API call). Otherwise it fails with "This post changed after approval. Review and approve it again."
- X: upload media first (images: simple upload; video: chunked INIT/APPEND/FINALIZE + STATUS polling) → create the post with `media_ids`. Threads: post part 1, then each next part as a reply to the previous id. Store every part's id; a failure mid-thread records which parts were posted and "Retry" continues from the next part.
- LinkedIn: images via the Images API (initializeUpload → PUT → asset URN), videos via the Videos API (initializeUpload, multipart PUT, finalizeUpload) → Posts API (`author: urn:li:person:<sub>`, `visibility: PUBLIC`, `lifecycleState: PUBLISHED`, `LinkedIn-Version` header, `X-Restli-Protocol-Version: 2.0.0`).
- Errors map to actionable messages: 401 → "Reconnect your account"; 403 → "Your app is missing permission <scope>"; 429 → retry after `x-rate-limit-reset`/`Retry-After` with exponential backoff (max 3); 5xx → retry; anything else → show the platform's message. On success: `status: published`, `publishedUrl` (X: `https://x.com/<handle>/status/<id>`; LinkedIn: `https://www.linkedin.com/feed/update/<urn>/`), `publishedAt`, and the same `lastSharedCommit` advance rule as M2.
- The publish sheet gains "Post now via <account>" (when connected) next to the assisted options, plus a confirm dialog that shows the exact text + media + account. Assisted options stay available.

## 3. Scheduling
- "Schedule…" in the publish sheet (date/time picker, local timezone shown) on an approved post → `status: scheduled`, `scheduledAt`. Editing the post clears approval **and** unschedules it (with a toast).
- A scheduler loop in the server (every 30 s) enqueues due publish jobs. It only runs while BIP is running, and the UI says so plainly. Optional: `bip publish-due` CLI command + a documented systemd user timer (`docs/scheduling.md`, with example unit files) for running when the app is closed. Missed schedules (the app was off) show as "Overdue" with "Post now" / "Reschedule"; they're **never auto-posted late** without the user clicking.
- Content page: a "Scheduled" view (list grouped by day; no calendar grid in M5).

## 4. Tests
- A mock X + LinkedIn server (in `tests/mocks/`) covering OAuth endpoints, media upload flows (including chunked video + status polling), post creation, 401/403/429/500 cases, and revoke.
- Unit: PKCE/state handling; keychain + encrypted fallback (force the fallback in tests); token redaction in logs; the approval re-check race (edit between enqueue and run → job refuses); idempotency (crash after the API success but before saving → no double post: implement this via the mock recording requests plus persisting the id first, then the status); thread partial failure + resume; rate-limit backoff; LinkedIn token expiry warnings; scheduler enqueueing, overdue handling, unschedule on edit.
- E2E: connect a mock X account through the real UI flow (redirect to the mock authorize page → callback) → approve a post with an image → Post now → published with a URL; schedule a LinkedIn post 1 min ahead (use a fake clock/env override for speed) → it publishes; and the no-accounts path still works exactly as in M2.
- Keep all previous tests green.

## Deliverable
`M5-RESULT.md` at the repo root, ≤ 50 lines.
