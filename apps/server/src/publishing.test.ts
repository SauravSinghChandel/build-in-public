import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOverdue, SCHEDULE_GRACE_MS, type PostData } from "@bip/shared";
import { createApp } from "./app.js";
import { git } from "./git.js";
import {
  createSecretStore,
  EncryptedFileStore,
  Scrubber,
  type KeyringEntry,
} from "./publishing/secrets.js";
import {
  challengeFor,
  endpoints,
  LinkedInApi,
  mayHavePosted,
  pkce,
  PlatformError,
  XApi,
  type HttpOptions,
} from "./publishing/platforms.js";
import { expiryStatus, STATE_TTL_MS } from "./publishing/accounts.js";
import { CHANGED_AFTER_APPROVAL, CHECK_BEFORE_RETRY } from "./publishing/publisher.js";
import { startPlatformMock, type PlatformMock } from "../../../tests/mocks/platforms.js";

let root: string, mock: PlatformMock, s: ReturnType<typeof createApp>, projectId: string;
let clock: number, waits: number[], head: string;
const env = (origin: string) => ({
  BIP_X_API_BASE: origin,
  BIP_X_AUTH_BASE: origin,
  BIP_LINKEDIN_API_BASE: origin,
  BIP_LINKEDIN_AUTH_BASE: origin,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m5-unit-"));
  mock = await startPlatformMock();
  vi.stubEnv("BIP_SECRET_STORE", "file");
  clock = Date.now();
  waits = [];
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  for (const n of [1, 2]) {
    await fs.writeFile(path.join(repo, "a.txt"), String(n));
    await git(repo, ["add", "."]);
    await git(repo, ["-c", "user.name=T", "-c", "user.email=t@localhost", "commit", "-m", `c${n}`]);
  }
  head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  s = createApp({
    home: path.join(root, "data"),
    fsHome: root,
    publishing: {
      endpoints: endpoints(env(mock.origin)),
      now: () => clock,
      backoffMs: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  });
  await s.projects.scan(root, 2);
  projectId = (await s.projects.track([repo]))[0].id;
});
afterEach(async () => {
  await s.close();
  await mock.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function request(url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return s.app.request("http://127.0.0.1:4310" + url, {
    method,
    headers: {
      host: "127.0.0.1:4310",
      cookie: `bip_session=${s.token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function ok<T = any>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await request("/api" + url, method, body);
  const data = await r.json();
  if (!r.ok) throw Error(data.error?.message || r.status);
  return data as T;
}
/** Runs the real OAuth round trip against the mock authorize page. */
async function connect(platform: "x" | "linkedin") {
  await ok(`/accounts/${platform}/app`, "PUT", {
    clientId: `${platform}-client`,
    ...(platform === "linkedin" ? { clientSecret: "li-client-secret-123" } : {}),
  });
  const r = await request(`/api/accounts/${platform}/connect`, "POST");
  const nonce = r.headers.get("set-cookie")!.match(new RegExp(`bip_oauth_${platform}=([^;]+)`))![1];
  const { url } = await r.json();
  const page = await (await fetch(url)).text();
  const back = new URL(page.match(/href="([^"]+)"/)![1].replace(/&amp;/g, "&"));
  const cb = await s.app.request(`http://127.0.0.1:4310${back.pathname}${back.search}`, {
    headers: { host: "127.0.0.1:4310", cookie: `bip_oauth_${platform}=${nonce}` },
  });
  return { location: cb.headers.get("location") || "", back, nonce };
}
async function story(platform: "x" | "linkedin", parts: string[]) {
  const st = await ok(`/projects/${projectId}/stories`, "POST", {
    title: "Ship it",
    commits: [head],
  });
  const post = await ok<PostData>(`/projects/${projectId}/stories/${st.id}/posts`, "POST", {
    platform,
    parts,
  });
  return { storyId: st.id as string, post: await read(st.id, post.id) };
}
async function read(storyId: string, postId: string) {
  return (await s.projects.store(projectId)).readPost(storyId, postId);
}
const postBase = (p: PostData) => `/projects/${projectId}/stories/${p.storyId}/posts/${p.id}`;
async function approve(p: PostData) {
  await ok(postBase(p) + "/approve", "POST", { revisionId: p.currentRevisionId, checked: [] });
  return read(p.storyId, p.id);
}
async function done(jobId: string) {
  await vi.waitFor(
    () => expect(["succeeded", "failed", "cancelled"]).toContain(s.content.jobs.get(jobId).status),
    { timeout: 10000, interval: 20 },
  );
  return s.content.jobs.get(jobId);
}
async function postNow(p: PostData) {
  const job = await ok(postBase(p) + "/post-now", "POST", { revisionId: p.currentRevisionId });
  return done(job.id);
}
const http = (): HttpOptions => ({
  backoffMs: 1,
  sleep: async (ms) => {
    waits.push(ms);
  },
  scrub: (t) => t,
});

describe("OAuth: PKCE and state", () => {
  it("derives the RFC 7636 S256 challenge and random verifiers", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const a = pkce(),
      b = pkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(challengeFor(a.verifier)).toBe(a.challenge);
  });
  it("connects X through the authorize page with PKCE and stores only metadata", async () => {
    const { location } = await connect("x");
    expect(location).toBe("/settings?section=accounts&connected=x");
    const token = mock.issued.x[0];
    const view = await ok("/accounts");
    expect(view.platforms[0].account).toMatchObject({ handle: "mockmaker", platform: "x" });
    expect(view.secretStore.kind).toBe("file");
    expect(JSON.stringify(view)).not.toContain(token);
    const row = s.db.prepare("SELECT * FROM accounts").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.keychain_ref).toBe(`x:${row.id}`);
    const tokenRequest = mock.requests.find((r) => r.path === "/2/oauth2/token")!;
    expect(tokenRequest.form!.code_verifier).toBeTruthy();
    const authorize = mock.requests.find((r) => r.path === "/i/oauth2/authorize")!;
    expect(authorize.query).toMatchObject({
      code_challenge_method: "S256",
      redirect_uri: "http://127.0.0.1:4310/oauth/x/callback",
      scope: "tweet.read tweet.write users.read media.write offline.access",
    });
  });
  it("rejects reused, unknown, foreign-browser and expired state", async () => {
    const first = await connect("x");
    // Replay the same callback: state is single-use.
    const replay = await s.app.request(
      `http://127.0.0.1:4310${first.back.pathname}${first.back.search}`,
      { headers: { host: "127.0.0.1:4310", cookie: `bip_oauth_x=${first.nonce}` } },
    );
    expect(decodeURIComponent(replay.headers.get("location")!)).toContain("already used");
    // Missing browser nonce.
    const { state } = s.accounts.begin("x");
    expect(() => s.accounts.consume("x", state, undefined)).toThrow("same browser");
    expect(() => s.accounts.consume("x", state, "anything")).toThrow("already used");
    // Expiry after 10 minutes.
    const fresh = s.accounts.begin("x");
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + STATE_TTL_MS + 1000);
    expect(() => s.accounts.consume("x", fresh.state, fresh.nonce)).toThrow("expired");
    vi.restoreAllMocks();
    // Wrong platform.
    const li = s.accounts.begin("x");
    expect(() => s.accounts.consume("linkedin", li.state, li.nonce)).toThrow();
  });
  it("keeps the callback unauthenticated but Host-checked; other routes stay authenticated", async () => {
    const bad = await s.app.request("http://evil.test/oauth/x/callback?state=a&code=b", {
      headers: { host: "evil.test" },
    });
    expect(bad.status).toBe(403);
    const anon = await s.app.request("http://127.0.0.1:4310/api/accounts", {
      headers: { host: "127.0.0.1:4310" },
    });
    expect(anon.status).toBe(401);
    const cb = await s.app.request("http://127.0.0.1:4310/oauth/x/callback?state=nope&code=b", {
      headers: { host: "127.0.0.1:4310" },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("oauthError=");
    expect(s.db.prepare("SELECT count(*) n FROM accounts").get()).toEqual({ n: 0 });
  });
  it("metadata-only account listing never touches the secret store", async () => {
    const spy = vi.spyOn(s.accounts, "secrets");
    const view = await ok("/accounts?metadata=1");
    expect(view.secretStore).toBeNull();
    expect(view.platforms.map((p: { platform: string }) => p.platform)).toEqual(["x", "linkedin"]);
    expect(spy).not.toHaveBeenCalled();
  });
  it("disconnect revokes, deletes secrets and the row", async () => {
    await connect("x");
    const token = mock.issued.x[0];
    const ref = (s.db.prepare("SELECT keychain_ref FROM accounts").get() as { keychain_ref: string }).keychain_ref;
    expect(s.accounts.secrets().get(`${ref}:access_token`)).toBe(token);
    const r = await ok("/accounts/x", "DELETE");
    expect(r.revoked).toBe(true);
    expect(mock.revoked).toContain(token);
    expect(s.accounts.secrets().get(`${ref}:access_token`)).toBeNull();
    expect(s.accounts.secrets().get(`${ref}:refresh_token`)).toBeNull();
    expect(r.view.platforms[0].account).toBeNull();
  });
});

describe("secret storage", () => {
  it("encrypted file fallback round-trips without plain text and with 0600 files", async () => {
    const dir = path.join(root, "secrets");
    const store = new EncryptedFileStore(dir);
    store.set("x:1:access_token", "super-secret-token-value");
    store.set("x:1:refresh_token", "another-secret");
    expect(store.get("x:1:access_token")).toBe("super-secret-token-value");
    const raw = await fs.readFile(path.join(dir, "secrets.enc"), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(statSync(path.join(dir, "secrets.key")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "secrets.enc")).mode & 0o777).toBe(0o600);
    store.delete("x:1:access_token");
    expect(new EncryptedFileStore(dir).get("x:1:access_token")).toBeNull();
    expect(new EncryptedFileStore(dir).get("x:1:refresh_token")).toBe("another-secret");
    // Tampering is detected by GCM.
    const box = JSON.parse(raw);
    box.data = Buffer.from("tampered").toString("base64");
    await fs.writeFile(path.join(dir, "secrets.enc"), JSON.stringify(box));
    expect(() => store.get("x:1:refresh_token")).toThrow();
  });
  it("uses the keychain when it works and falls back when it doesn't", () => {
    const vault = new Map<string, string>();
    const fake = (service: string, account: string): KeyringEntry => ({
      getPassword: () => vault.get(`${service}/${account}`) ?? null,
      setPassword: (v) => void vault.set(`${service}/${account}`, v),
      deletePassword: () => vault.delete(`${service}/${account}`),
    });
    const keychain = createSecretStore(root, { mode: "auto", entry: fake });
    expect(keychain.kind).toBe("keychain");
    keychain.set("linkedin:abc:access_token", "tok-123456");
    expect(vault.get("build-in-public/linkedin:abc:access_token")).toBe("tok-123456");
    expect([...vault.keys()].some((k) => k.includes("probe"))).toBe(false);
    const broken = () => {
      throw Error("No secret service");
    };
    expect(createSecretStore(root, { mode: "auto", entry: broken }).kind).toBe("file");
    expect(createSecretStore(root, { mode: "file", entry: fake }).kind).toBe("file");
    expect(() => createSecretStore(root, { mode: "keychain", entry: broken })).toThrow();
  });
  it("stores account tokens in the keychain under service build-in-public", async () => {
    const vault = new Map<string, string>();
    await s.close();
    s = createApp({
      home: path.join(root, "data2"),
      fsHome: root,
      publishing: {
        endpoints: endpoints(env(mock.origin)),
        secrets: createSecretStore(root, {
          mode: "keychain",
          entry: (service, account) => ({
            getPassword: () => vault.get(`${service}/${account}`) ?? null,
            setPassword: (v) => void vault.set(`${service}/${account}`, v),
            deletePassword: () => vault.delete(`${service}/${account}`),
          }),
        }),
      },
    });
    await connect("x");
    const id = (s.db.prepare("SELECT id FROM accounts").get() as { id: string }).id;
    expect(vault.get(`build-in-public/x:${id}:access_token`)).toBe(mock.issued.x[0]);
    expect(vault.get(`build-in-public/x:${id}:refresh_token`)).toMatch(/^x-rt-/);
    expect((await ok("/accounts")).secretStore).toEqual({ kind: "keychain" });
  });
  it("redacts tokens from logs, job errors and API responses", async () => {
    const scrubber = new Scrubber();
    scrubber.add("x-at-abcdef123456");
    expect(scrubber.scrub("failed with x-at-abcdef123456 in it")).toBe("failed with [REDACTED] in it");
    expect(scrubber.scrub("Authorization: Bearer abc.def-ghi_jkl")).toBe("Authorization: Bearer [REDACTED]");
    expect(scrubber.scrub('{"access_token":"zzzzzzzzzz"}')).toBe('{"access_token":"[REDACTED]"}');
    await connect("x");
    const token = mock.issued.x[0];
    const { post } = await story("x", ["Hello from BIP"]);
    const approved = await approve(post);
    mock.fail({ method: "POST", path: "/2/tweets", status: 400, body: { detail: `bad token ${token}` } });
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const)
      vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(" ")));
    const job = await postNow(approved);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("[REDACTED]");
    const all = JSON.stringify([
      job,
      await ok("/jobs"),
      await ok("/accounts"),
      await ok("/content"),
      logs,
    ]);
    expect(all).not.toContain(token);
  });
});

describe("publishing", () => {
  it("posts an X image post via the API and advances the shared marker", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Look at this"]);
    const asset = await s.images.assets.put(projectId, Buffer.alloc(2048, 7), "upload", { type: "upload", filename: "a.png" }, { mime: "image/png", width: 10, height: 10 });
    await ok(postBase(post) + "/media", "PUT", { media: [{ sha: asset.sha, alt: "A chart" }] });
    const job = await postNow(await approve(await read(storyId, post.id)));
    expect(job.status).toBe("succeeded");
    expect(mock.tweets).toHaveLength(1);
    expect(mock.tweets[0].mediaIds).toHaveLength(1);
    expect(mock.count("POST", "/2/media/metadata")).toBe(1);
    const after = await read(storyId, post.id);
    expect(after).toMatchObject({
      status: "published",
      externalId: mock.tweets[0].id,
      publishedUrl: `https://x.com/mockmaker/status/${mock.tweets[0].id}`,
    });
    expect((await s.projects.store(projectId)).project.lastSharedCommit).toBe(head);
  });
  it("posts a LinkedIn post with the Posts API headers", async () => {
    await connect("linkedin");
    const { post, storyId } = await story("linkedin", ["A longer LinkedIn update."]);
    const job = await postNow(await approve(post));
    expect(job.status).toBe("succeeded");
    const req = mock.requests.find((r) => r.path === "/rest/posts")!;
    expect(req.headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(req.headers["linkedin-version"]).toMatch(/^\d{6}$/);
    expect(req.json).toMatchObject({ author: "urn:li:person:li-member-7", visibility: "PUBLIC", lifecycleState: "PUBLISHED" });
    expect((await read(storyId, post.id)).publishedUrl).toBe(
      `https://www.linkedin.com/feed/update/${mock.linkedinPosts[0].urn}/`,
    );
  });
  it("refuses when the post changed between enqueue and the API call", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Original"]);
    const approved = await approve(post);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = s.accounts.token.bind(s.accounts);
    vi.spyOn(s.accounts, "token").mockImplementation(async (...a) => {
      await gate;
      return real(...a);
    });
    const job = await ok(postBase(approved) + "/post-now", "POST", { revisionId: approved.currentRevisionId });
    await vi.waitFor(() => expect(s.content.jobs.get(job.id).status).toBe("running"));
    await ok(postBase(approved) + "/revisions", "POST", { parts: ["Edited after approval"], coalesce: false });
    release();
    const result = await done(job.id);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(CHANGED_AFTER_APPROVAL);
    expect(mock.count("POST", "/2/tweets")).toBe(0);
    expect((await read(storyId, post.id)).status).toBe("draft");
    // Without re-approval, Post now is refused up front.
    const edited = await read(storyId, post.id);
    await expect(ok(postBase(edited) + "/post-now", "POST", { revisionId: edited.currentRevisionId })).rejects.toThrow(
      CHANGED_AFTER_APPROVAL,
    );
  });
  it("is idempotent: a crash after the API success never double-posts", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Only once"]);
    const approved = await approve(post);
    s.publisher.afterPersist = () => {
      throw Error("Simulated crash after saving the id");
    };
    const first = await postNow(approved);
    expect(first.status).toBe("failed");
    const crashed = await read(storyId, post.id);
    expect(crashed.externalId).toBe(mock.tweets[0].id);
    expect(crashed.status).toBe("failed");
    s.publisher.afterPersist = undefined;
    const retry = await postNow(crashed);
    expect(retry.status).toBe("succeeded");
    expect(mock.count("POST", "/2/tweets")).toBe(1);
    expect((await read(storyId, post.id)).status).toBe("published");
  });
  it("records a mid-thread failure and Retry continues from the next part", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Part one", "Part two", "Part three"]);
    const approved = await approve(post);
    mock.fail({ method: "POST", path: "/2/tweets", status: 400, after: 1, body: { detail: "Duplicate content" } });
    const job = await postNow(approved);
    expect(job.status).toBe("failed");
    const partial = await read(storyId, post.id);
    expect(partial.externalIds).toHaveLength(1);
    expect(partial.status).toBe("failed");
    expect(partial.error).toBe("Posted 1 part. X: Duplicate content Retry continues from part 2.");
    const retry = await postNow(partial);
    expect(retry.status).toBe("succeeded");
    expect(mock.tweets.map((t) => t.text)).toEqual(["Part one", "Part two", "Part three"]);
    expect(mock.tweets[1].replyTo).toBe(mock.tweets[0].id);
    expect(mock.tweets[2].replyTo).toBe(mock.tweets[1].id);
    expect((await read(storyId, post.id)).externalIds).toEqual(mock.tweets.map((t) => t.id));
  });
  it("backs off on 429 (also for create) and 5xx on uploads (max 3 retries); maps 401/403", async () => {
    await connect("x");
    mock.fail({ method: "POST", path: "/2/tweets", status: 429, times: 2, headers: { "retry-after": "0" } });
    const a = await story("x", ["Rate limited"]);
    expect((await postNow(await approve(a.post))).status).toBe("succeeded");
    expect(waits).toEqual([1, 2]);
    expect(mock.count("POST", "/2/tweets")).toBe(3);
    const x = new XApi(endpoints(env(mock.origin)).x, http());
    const image = { bytes: Buffer.alloc(10), mime: "image/png" };
    waits = [];
    mock.fail({ method: "POST", path: "/2/media/upload", status: 503, times: 1 });
    expect(await x.upload(mock.issued.x[0], image)).toBeTruthy();
    expect(waits).toEqual([1]);
    waits = [];
    mock.fail({ method: "POST", path: "/2/media/upload", status: 500, times: 4 });
    await expect(x.upload(mock.issued.x[0], image)).rejects.toThrow("X is having problems (500)");
    expect(waits).toHaveLength(3);
    mock.fail({
      method: "POST",
      path: "/2/tweets",
      status: 429,
      headers: { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
    });
    const c = await story("x", ["Far reset"]);
    expect((await postNow(await approve(c.post))).error).toContain("rate limit reached. Try again after");
    mock.fail({ method: "POST", path: "/2/tweets", status: 401 });
    const d = await story("x", ["Unauthorized"]);
    expect((await postNow(await approve(d.post))).error).toContain("Reconnect your account");
    mock.fail({ method: "POST", path: "/2/tweets", status: 403, body: { detail: "Forbidden" } });
    const e = await story("x", ["Forbidden"]);
    expect((await postNow(await approve(e.post))).error).toContain("Your app is missing permission tweet.write");
    expect(mock.tweets).toHaveLength(1);
  });
  it("never auto-retries create after a 5xx: May have posted, then Retry anyway sends exactly one more", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Maybe live"]);
    const approved = await approve(post);
    mock.fail({ method: "POST", path: "/2/tweets", status: 503 });
    const job = await postNow(approved);
    expect(job.status).toBe("failed");
    expect(job.error).toBe(mayHavePosted("x"));
    expect(mock.count("POST", "/2/tweets")).toBe(1);
    expect(waits).toEqual([]);
    const uncertain = await read(storyId, post.id);
    expect(uncertain).toMatchObject({ status: "uncertain", error: mayHavePosted("x") });
    // Neither Post now, a plain job Resume, nor the scheduler re-sends it.
    await expect(ok(postBase(uncertain) + "/post-now", "POST", { revisionId: uncertain.currentRevisionId })).rejects.toThrow(
      CHECK_BEFORE_RETRY,
    );
    await expect(
      ok(postBase(uncertain) + "/schedule", "POST", {
        revisionId: uncertain.currentRevisionId,
        scheduledAt: new Date(clock + 60_000).toISOString(),
      }),
    ).rejects.toThrow(CHECK_BEFORE_RETRY);
    s.content.jobs.resume(job.id);
    expect((await done(job.id)).error).toBe(CHECK_BEFORE_RETRY);
    await s.publisher.tick();
    expect(mock.count("POST", "/2/tweets")).toBe(1);
    const retry = await ok(postBase(uncertain) + "/post-now", "POST", {
      revisionId: uncertain.currentRevisionId,
      retryUncertain: true,
    });
    expect((await done(retry.id)).status).toBe("succeeded");
    expect(mock.count("POST", "/2/tweets")).toBe(2);
    expect((await read(storyId, post.id)).status).toBe("published");
  });
  it("treats create timeouts and network errors as May have posted; uploads still retry", async () => {
    await connect("x");
    const token = mock.issued.x[0];
    const x = new XApi(endpoints(env(mock.origin)).x, { ...http(), timeoutMs: 100 });
    mock.fail({ method: "POST", path: "/2/tweets", status: 201, delayMs: 400, body: { data: { id: "1" } } });
    const timedOut = await x.createPost(token, { text: "slow", mediaIds: [] }).catch((e) => e);
    expect(timedOut).toBeInstanceOf(PlatformError);
    expect(timedOut.uncertain).toBe(true);
    expect(mock.count("POST", "/2/tweets")).toBe(1);
    const dead = new XApi({ api: "http://127.0.0.1:9", auth: "http://127.0.0.1:9" }, http());
    waits = [];
    const offline = await dead.createPost(token, { text: "offline", mediaIds: [] }).catch((e) => e);
    expect(offline.uncertain).toBe(true);
    expect(waits).toEqual([]);
    await expect(dead.upload(token, { bytes: Buffer.alloc(5), mime: "image/png" })).rejects.toThrow("Could not reach X");
    expect(waits).toEqual([1, 2, 4]);
  });
  it("applies May have posted per thread part; It posted records the part and Retry continues", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["One", "Two", "Three"]);
    const approved = await approve(post);
    // Part 2 is actually created, but X answers 503.
    mock.fail({ method: "POST", path: "/2/tweets", status: 503, after: 1, commit: true });
    await postNow(approved);
    const uncertain = await read(storyId, post.id);
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.error).toBe(`Part 2 of 3: ${mayHavePosted("x")} Part 1 is posted.`);
    expect(uncertain.externalIds).toEqual([mock.tweets[0].id]);
    expect(mock.count("POST", "/2/tweets")).toBe(2);
    await expect(
      ok(postBase(uncertain) + "/confirm-posted", "POST", { url: "https://linkedin.com/feed/update/x/" }),
    ).rejects.toThrow("matching platform");
    const confirmed = await ok<PostData>(postBase(uncertain) + "/confirm-posted", "POST", {
      url: `https://x.com/mockmaker/status/${mock.tweets[1].id}`,
    });
    expect(confirmed).toMatchObject({ status: "failed", externalIds: [mock.tweets[0].id, mock.tweets[1].id] });
    expect(confirmed.error).toBe("Posted 2 of 3 parts. Retry continues from part 3.");
    expect((await postNow(confirmed)).status).toBe("succeeded");
    expect(mock.count("POST", "/2/tweets")).toBe(3);
    expect(mock.tweets.map((t) => t.text)).toEqual(["One", "Two", "Three"]);
    expect(mock.tweets[2].replyTo).toBe(mock.tweets[1].id);
    expect((await read(storyId, post.id)).publishedUrl).toBe(`https://x.com/mockmaker/status/${mock.tweets[0].id}`);
  });
  it("It posted on an uncertain LinkedIn post marks it published like the assisted flow", async () => {
    await connect("linkedin");
    const { post, storyId } = await story("linkedin", ["LinkedIn maybe"]);
    mock.fail({ method: "POST", path: "/rest/posts", status: 502, commit: true });
    const job = await postNow(await approve(post));
    expect(job.error).toBe(mayHavePosted("linkedin"));
    expect(mock.count("POST", "/rest/posts")).toBe(1);
    const urn = mock.linkedinPosts[0].urn;
    const url = `https://www.linkedin.com/feed/update/${urn}/`;
    const published = await ok<PostData>(postBase(await read(storyId, post.id)) + "/confirm-posted", "POST", { url });
    expect(published).toMatchObject({ status: "published", publishedUrl: url, externalId: urn });
    expect((await s.projects.store(projectId)).project.lastSharedCommit).toBe(head);
    expect(mock.count("POST", "/rest/posts")).toBe(1);
  });
  it("refreshes an expired X token before posting", async () => {
    mock.expiresIn.x = 30;
    await connect("x");
    const { post } = await story("x", ["Fresh token"]);
    expect((await postNow(await approve(post))).status).toBe("succeeded");
    expect(mock.issued.x).toHaveLength(2);
    expect(mock.requests.find((r) => r.path === "/2/tweets")!.headers.authorization).toBe(`Bearer ${mock.issued.x[1]}`);
  });
  it("uploads X video in chunks with STATUS polling, and LinkedIn image/video", async () => {
    vi.stubEnv("BIP_X_CHUNK_BYTES", "1000");
    await connect("x");
    await connect("linkedin");
    const ep = endpoints(env(mock.origin));
    const xToken = mock.issued.x[0],
      liToken = mock.issued.linkedin[0];
    const x = new XApi(ep.x, http());
    const id = await x.upload(xToken, { bytes: Buffer.alloc(2500, 1), mime: "video/mp4" });
    expect(mock.media.get(id)).toMatchObject({ kind: "video", bytes: 2500, segments: 3, statusChecks: 2 });
    expect(await x.createPost(xToken, { text: "video", mediaIds: [id] })).toBeTruthy();
    const li = new LinkedInApi(ep.linkedin, http());
    const owner = "urn:li:person:li-member-7";
    const image = await li.upload(liToken, owner, { bytes: Buffer.alloc(100), mime: "image/png" });
    expect(image).toMatch(/^urn:li:image:/);
    const video = await li.upload(liToken, owner, { bytes: Buffer.alloc(9 * 1024 * 1024), mime: "video/mp4" });
    expect(mock.media.get(video)).toMatchObject({ segments: 3, bytes: 9 * 1024 * 1024, statusChecks: 2 });
    expect(mock.count("GET", /^\/rest\/videos\/urn/)).toBe(2);
    expect(mock.count("PUT", /^\/upload\/video\//)).toBe(3);
    const urn = await li.createPost(liToken, { author: owner, text: "with video", media: [{ id: video }] });
    expect(mock.linkedinPosts.at(-1)!.body.content.media.id).toBe(video);
    expect(urn).toMatch(/^urn:li:share:/);
    mock.linkedinVideoOutcome = "PROCESSING_FAILED";
    await expect(li.upload(liToken, owner, { bytes: Buffer.alloc(10), mime: "video/mp4" })).rejects.toThrow(
      "LinkedIn could not process the video",
    );
    mock.linkedinVideoOutcome = "AVAILABLE";
    await expect(li.videoReady(liToken, "urn:li:video:nope", 1)).rejects.toThrow();
  });
  it("warns before LinkedIn tokens expire and refuses expired ones", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(expiryStatus(null, now)).toBe("ok");
    expect(expiryStatus("2026-03-01T00:00:00Z", now)).toBe("ok");
    expect(expiryStatus("2026-01-05T00:00:00Z", now)).toBe("soon");
    expect(expiryStatus("2025-12-31T00:00:00Z", now)).toBe("expired");
    mock.expiresIn.linkedin = 3 * 24 * 60 * 60;
    await connect("linkedin");
    const account = (await ok("/accounts")).platforms[1].account;
    expect(account.expiry).toBe("soon");
    expect(account.reconnectBy).toBe(account.expiresAt);
    clock += 4 * 24 * 60 * 60 * 1000;
    expect((await ok("/accounts")).platforms[1].account.expiry).toBe("expired");
    const { post } = await story("linkedin", ["Expired"]);
    await expect(
      ok(postBase(post) + "/post-now", "POST", { revisionId: (await approve(post)).currentRevisionId }),
    ).rejects.toThrow("Reconnect your account");
  });
});

describe("scheduling", () => {
  it("enqueues due posts on the scheduler tick", async () => {
    await connect("linkedin");
    const { post, storyId } = await story("linkedin", ["Scheduled update"]);
    const approved = await approve(post);
    await expect(
      ok(postBase(approved) + "/schedule", "POST", { revisionId: approved.currentRevisionId, scheduledAt: new Date(clock - 1000).toISOString() }),
    ).rejects.toThrow("future");
    const at = new Date(clock + 60_000).toISOString();
    const scheduled = await ok<PostData>(postBase(approved) + "/schedule", "POST", { revisionId: approved.currentRevisionId, scheduledAt: at });
    expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: at });
    expect(await s.publisher.tick()).toBe(0);
    clock += 61_000;
    expect(await s.publisher.tick()).toBe(1);
    const job = s.content.jobs.list().find((j) => j.type === "publish")!;
    expect((await done(job.id)).status).toBe("succeeded");
    expect(job.payload.trigger).toBe("schedule");
    expect((await read(storyId, post.id)).status).toBe("published");
    expect(mock.linkedinPosts).toHaveLength(1);
  });
  it("never auto-posts a missed schedule; it shows as Overdue", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Missed"]);
    const approved = await approve(post);
    await ok(postBase(approved) + "/schedule", "POST", {
      revisionId: approved.currentRevisionId,
      scheduledAt: new Date(clock + 60_000).toISOString(),
    });
    clock += 60_000 + SCHEDULE_GRACE_MS + 1000; // the app was off
    expect(await s.publisher.tick()).toBe(0);
    const overdue = await read(storyId, post.id);
    expect(overdue.status).toBe("scheduled");
    expect(isOverdue(overdue, clock)).toBe(true);
    expect(mock.count("POST", "/2/tweets")).toBe(0);
    // The user clicks Post now.
    expect((await postNow(overdue)).status).toBe("succeeded");
  });
  it("editing a scheduled post clears approval and unschedules it", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Before"]);
    const approved = await approve(post);
    await ok(postBase(approved) + "/schedule", "POST", {
      revisionId: approved.currentRevisionId,
      scheduledAt: new Date(clock + 60_000).toISOString(),
    });
    await ok(postBase(approved) + "/revisions", "POST", { parts: ["After"], coalesce: false });
    const edited = await read(storyId, post.id);
    expect(edited.status).toBe("draft");
    expect(edited.scheduledAt).toBeUndefined();
    expect(edited.approvedRevisionId).toBeUndefined();
    clock += 61_000;
    expect(await s.publisher.tick()).toBe(0);
    // Explicit unschedule returns to approved.
    const again = await approve(edited);
    await ok(postBase(again) + "/schedule", "POST", {
      revisionId: again.currentRevisionId,
      scheduledAt: new Date(clock + 60_000).toISOString(),
    });
    expect((await ok<PostData>(postBase(again) + "/unschedule", "POST")).status).toBe("approved");
  });
  it("publish-due runs one pass and waits for the jobs", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Timer"]);
    const approved = await approve(post);
    await ok(postBase(approved) + "/schedule", "POST", {
      revisionId: approved.currentRevisionId,
      scheduledAt: new Date(clock + 30_000).toISOString(),
    });
    clock += 31_000;
    const result = await s.publisher.runDue();
    expect(result.enqueued).toBe(1);
    expect(result.jobs[0].status).toBe("succeeded");
    expect((await read(storyId, post.id)).status).toBe("published");
  });
  it("releases a post stuck in publishing after its job stopped", async () => {
    await connect("x");
    const { post, storyId } = await story("x", ["Stuck"]);
    const approved = await approve(post);
    const job = await ok(postBase(approved) + "/post-now", "POST", { revisionId: approved.currentRevisionId });
    await done(job.id);
    const st = await s.projects.store(projectId);
    await st.updatePost(storyId, post.id, { status: "publishing", externalId: undefined, externalIds: undefined, publishedUrl: undefined });
    s.db.prepare("UPDATE jobs SET status='interrupted' WHERE id=?").run(job.id);
    await s.publisher.tick();
    const released = await read(storyId, post.id);
    expect(released.status).toBe("failed");
    expect(released.error).toContain("stopped before it finished");
  });
});
