# M5b result: accounts, direct publishing, scheduling (brief §1–4)

Built:
- Settings → Accounts: guide (redirect URI, scopes, X pricing link, LinkedIn products), Client ID/Secret, Connect,
  "Reconnect by <date>" (+7-day warning), Disconnect (revoke + delete). X OAuth + PKCE S256; LinkedIn code flow.
  `state` random, single-use, 10 min, browser-bound cookie; callback = only unauthenticated route (Host-checked).
- `publishing/secrets.ts`: SecretStore = keychain (`@napi-rs/keyring`, service `build-in-public`,
  `<platform>:<accountId>:<kind>`) or AES-256-GCM `secrets.enc` + 0600 key file, with a Settings warning.
  Lazy; `BIP_SECRET_STORE` forces it. Migration 003: `platform_apps`/`accounts` (metadata only). Token scrubber.
- `publish` jobs (`post:<id>`): approval re-checked at start and before every create call; X image/alt,
  chunked video + STATUS polling, threads as reply chains; LinkedIn Images/Videos API + Posts API headers.
  Ids persisted to `externalIds` before status; Retry continues threads; 429 backoff (max 3); uploads/polls also
  retry 5xx/timeout/network. Create-post is never auto-retried after 5xx/timeout/network error: status `uncertain`
  ("May have posted… Check your profile before retrying.", per thread part) with "It posted" (paste link → recorded/
  published like assisted) and "Retry anyway" (confirm → exactly one more create). LinkedIn video polled to AVAILABLE.
  401/403 messages; `publishedUrl`/`publishedAt` + M2 marker rule. X token refresh.
- Publish sheet: "Post now via <account>" + confirm dialog (exact parts, media, account), Schedule… (local TZ shown),
  Reschedule/Unschedule, Retry with error; assisted options unchanged. Editing unschedules (server) + toast.
- Scheduler (30 s, in-process) enqueues posts ≤ 2 min late; later = Overdue (never auto-posted); releases stuck
  `publishing` posts. `bip publish-due` CLI (skips if app is running). Content → Scheduled view grouped by day.
- Docs: `docs/scheduling.md` (systemd user timer), M5 section in `docs/architecture.md`.

Validation (XDG_CONFIG_HOME=/tmp/bip-m5b/config):
- `typecheck` PASS · `build` PASS (existing chunk-size warning).
- `test` PASS: 105 tests (77 previous + 28 new in `apps/server/src/publishing.test.ts`).
- `test:e2e` PASS: 5 specs; new `m5.spec.ts` (connect X + LinkedIn via mock authorize page → image thread
  Post now → published URL; LinkedIn scheduled 1 min ahead with clock offset → published). `m2.spec.ts` now also
  asserts no Post now/Schedule without accounts.
- Mock X + LinkedIn: `tests/mocks/platforms.ts` (OAuth/PKCE, media, video status, posts, revoke, failure injection).

Deviations / notes:
- One account per platform (reconnecting replaces it). OAuth state lives in memory (server restart = connect again).
- `GET /api/accounts?metadata=1` (publish sheet) never touches the keychain; only Settings probes it.
- Test-only env hooks: `BIP_TEST_CLOCK_OFFSET_MS`, `BIP_SCHEDULER_INTERVAL_MS`, `BIP_PUBLISH_BACKOFF_MS`, `BIP_X_CHUNK_BYTES`.
- `core.test.ts` migration version assertion bumped 2 → 3. No commits made.

Gaps:
- No live X/LinkedIn calls were made; endpoint shapes (X v2 media upload endpoints, LinkedIn-Version `202510`) need a host smoke test.
- "May have posted" is covered by unit tests only (no e2e). X follow-ups reply to the parent; LinkedIn follow-ups post standalone.
- Keychain probe is synchronous; a locked desktop keyring could prompt/block when opening Settings → Accounts.
