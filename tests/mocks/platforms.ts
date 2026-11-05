/**
 * Local mock of the X and LinkedIn APIs used by BIP's direct publishing (M5).
 * Point BIP_X_API_BASE, BIP_X_AUTH_BASE, BIP_LINKEDIN_API_BASE and
 * BIP_LINKEDIN_AUTH_BASE at `origin`. Every request is recorded; failures can be
 * injected per route. Never talks to the real platforms.
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  bytes: number;
  json?: any;
  form?: Record<string, string>;
}
interface Failure {
  method?: string;
  path: string | RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times: number;
  /** Let this many matching requests succeed first. */
  after?: number;
  /** Wait before answering (to trigger client timeouts). */
  delayMs?: number;
  /** Process the request normally (e.g. create the post), then answer with the failure. */
  commit?: boolean;
}
export interface PlatformMock {
  origin: string;
  requests: Recorded[];
  tweets: { id: string; text: string; mediaIds: string[]; replyTo?: string }[];
  linkedinPosts: { urn: string; body: any }[];
  revoked: string[];
  media: Map<string, { kind: string; bytes: number; segments: number; statusChecks: number }>;
  /** Respond to the next `times` matching requests with this status instead. */
  fail(f: Omit<Failure, "times"> & { times?: number }): void;
  /** Final processing status reported for LinkedIn videos. */
  linkedinVideoOutcome: "AVAILABLE" | "PROCESSING_FAILED";
  /** Seconds until issued tokens expire. */
  expiresIn: { x: number; linkedin: number };
  issued: { x: string[]; linkedin: string[] };
  /** Count of requests matching method + path. */
  count(method: string, path: string | RegExp): number;
  close(): Promise<void>;
}

const X_USER = { id: "4242", name: "Mock Maker", username: "mockmaker" };
const LI_USER = { sub: "li-member-7", name: "Mock Person" };

function authorizePage(title: string, redirect: string) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<main style="font-family:sans-serif;max-width:32rem;margin:4rem auto">
<h1>${title}</h1><p>Build in Public (mock) wants to post on your behalf.</p>
<a id="authorize" href="${redirect.replace(/"/g, "&quot;")}">Authorize app</a>
</main>`;
}

export async function startPlatformMock(): Promise<PlatformMock> {
  const requests: Recorded[] = [];
  const failures: Failure[] = [];
  const codes = new Map<
    string,
    { platform: "x" | "linkedin"; clientId: string; redirectUri: string; challenge?: string; scope: string }
  >();
  const tokens = new Map<string, { platform: "x" | "linkedin"; refresh?: string }>();
  const refreshTokens = new Map<string, string>();
  const tweets: PlatformMock["tweets"] = [];
  const linkedinPosts: PlatformMock["linkedinPosts"] = [];
  const revoked: string[] = [];
  const media: PlatformMock["media"] = new Map();
  const videoParts = new Map<string, { etags: string[]; size: number }>();
  const issued = { x: [] as string[], linkedin: [] as string[] };
  const expiresIn = { x: 7200, linkedin: 60 * 24 * 60 * 60 };
  let seq = 1000;
  const state = { linkedinVideoOutcome: "AVAILABLE" as PlatformMock["linkedinVideoOutcome"] };
  let origin = "";

  function issue(platform: "x" | "linkedin", scope: string) {
    const access = `${platform}-at-${randomBytes(12).toString("hex")}`;
    const refresh = platform === "x" ? `${platform}-rt-${randomBytes(12).toString("hex")}` : undefined;
    tokens.set(access, { platform, refresh });
    if (refresh) refreshTokens.set(refresh, access);
    issued[platform].push(access);
    return {
      token_type: "bearer",
      access_token: access,
      ...(refresh ? { refresh_token: refresh } : {}),
      expires_in: expiresIn[platform],
      scope,
    };
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url || "/", "http://mock");
    const ctype = String(req.headers["content-type"] || "");
    const rec: Recorded = {
      method: req.method || "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      bytes: raw.length,
    };
    if (ctype.includes("application/json") && raw.length) rec.json = JSON.parse(raw.toString());
    if (ctype.includes("x-www-form-urlencoded"))
      rec.form = Object.fromEntries(new URLSearchParams(raw.toString()));
    requests.push(rec);
    let override: Failure | undefined;
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (override) {
        status = override.status;
        body = override.body ?? { detail: `Injected ${override.status}` };
        headers = override.headers ?? {};
      }
      res.writeHead(status, {
        ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
        ...headers,
      });
      res.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
    };
    let failure = failures.find(
      (f) =>
        f.times > 0 &&
        (!f.method || f.method === rec.method) &&
        (typeof f.path === "string" ? f.path === rec.path : f.path.test(rec.path)),
    );
    if (failure?.after) {
      failure.after--;
      failure = undefined;
    }
    if (failure) {
      failure.times--;
      if (failure.delayMs) await new Promise((r) => setTimeout(r, failure!.delayMs));
      if (failure.commit) override = failure;
    }
    if (failure && !failure.commit) {
      return send(failure.status, failure.body ?? { detail: `Injected ${failure.status}` }, failure.headers);
    }
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const authed = (platform: "x" | "linkedin") => {
      const t = tokens.get(bearer);
      return !!t && t.platform === platform && !revoked.includes(bearer);
    };
    const form = async () => {
      // multipart parsing via WHATWG Request
      const r = new Request("http://mock/", {
        method: "POST",
        headers: { "content-type": ctype },
        body: raw,
      });
      return r.formData();
    };
    const p = rec.path;
    try {
      // ---------------- X ----------------
      if (p === "/i/oauth2/authorize") {
        const q = rec.query;
        if (q.code_challenge_method !== "S256" || !q.code_challenge || !q.state)
          return send(400, "PKCE (S256) and state are required");
        const code = `xcode-${randomBytes(8).toString("hex")}`;
        codes.set(code, {
          platform: "x",
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          challenge: q.code_challenge,
          scope: q.scope,
        });
        const back = new URL(q.redirect_uri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.state);
        return send(200, authorizePage("Authorize X (mock)", back.toString()), {
          "content-type": "text/html",
        });
      }
      if (p === "/2/oauth2/token" && rec.method === "POST") {
        const f = rec.form || {};
        if (f.grant_type === "authorization_code") {
          const entry = codes.get(f.code);
          codes.delete(f.code);
          if (!entry || entry.platform !== "x") return send(400, { error: "invalid_grant", error_description: "Unknown code" });
          if (entry.redirectUri !== f.redirect_uri || entry.clientId !== f.client_id)
            return send(400, { error: "invalid_request", error_description: "redirect_uri or client_id mismatch" });
          const challenge = createHash("sha256").update(f.code_verifier || "").digest("base64url");
          if (challenge !== entry.challenge)
            return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return send(200, issue("x", entry.scope));
        }
        if (f.grant_type === "refresh_token") {
          const old = refreshTokens.get(f.refresh_token);
          if (!old) return send(400, { error: "invalid_grant", error_description: "Unknown refresh token" });
          refreshTokens.delete(f.refresh_token);
          revoked.push(old);
          return send(200, issue("x", "tweet.read tweet.write users.read media.write offline.access"));
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      if (p === "/2/oauth2/revoke") {
        revoked.push(rec.form?.token || "");
        return send(200, { revoked: true });
      }
      if (p.startsWith("/2/") && !authed("x"))
        return send(401, { title: "Unauthorized", detail: "Unauthorized", status: 401 });
      if (p === "/2/users/me") return send(200, { data: X_USER });
      if (p === "/2/media/upload" && rec.method === "POST") {
        const data = await form();
        const file = data.get("media");
        if (!(file instanceof Blob)) return send(400, { detail: "media is required" });
        const id = String(++seq);
        media.set(id, { kind: "image", bytes: file.size, segments: 0, statusChecks: 0 });
        return send(200, { data: { id, media_key: `3_${id}`, size: file.size } });
      }
      if (p === "/2/media/upload" && rec.method === "GET" && rec.query.command === "STATUS") {
        const m = media.get(rec.query.media_id);
        if (!m) return send(404, { detail: "Unknown media" });
        m.statusChecks++;
        const state = m.statusChecks >= 2 ? "succeeded" : "in_progress";
        return send(200, {
          data: { id: rec.query.media_id, processing_info: { state, check_after_secs: 1, progress_percent: state === "succeeded" ? 100 : 50 } },
        });
      }
      if (p === "/2/media/upload/initialize") {
        const id = String(++seq);
        media.set(id, { kind: "video", bytes: 0, segments: 0, statusChecks: 0 });
        return send(200, { data: { id, media_key: `7_${id}`, expires_after_secs: 86400 } });
      }
      let m = p.match(/^\/2\/media\/upload\/(\d+)\/append$/);
      if (m) {
        const entry = media.get(m[1]);
        const data = await form();
        const chunk = data.get("media");
        if (!entry || !(chunk instanceof Blob) || Number(data.get("segment_index")) !== entry.segments)
          return send(400, { detail: "Bad segment" });
        entry.segments++;
        entry.bytes += chunk.size;
        return send(200, {});
      }
      m = p.match(/^\/2\/media\/upload\/(\d+)\/finalize$/);
      if (m) {
        const entry = media.get(m[1]);
        if (!entry || !entry.segments) return send(400, { detail: "Nothing uploaded" });
        return send(200, {
          data: { id: m[1], size: entry.bytes, processing_info: { state: "pending", check_after_secs: 1 } },
        });
      }
      if (p === "/2/media/metadata") return send(200, { data: { associated_metadata: true } });
      if (p === "/2/tweets" && rec.method === "POST") {
        const body = rec.json || {};
        const ids: string[] = body.media?.media_ids || [];
        for (const id of ids) {
          const entry = media.get(id);
          if (!entry) return send(400, { detail: `Unknown media id ${id}` });
          if (entry.kind === "video" && entry.statusChecks < 2)
            return send(400, { detail: "Media is still processing" });
        }
        const replyTo = body.reply?.in_reply_to_tweet_id;
        if (replyTo && !tweets.some((t) => t.id === replyTo))
          return send(400, { detail: "Reply target not found" });
        const id = String(1_800_000_000_000_000_000n + BigInt(++seq));
        tweets.push({ id, text: body.text, mediaIds: ids, replyTo });
        return send(201, { data: { id, text: body.text } });
      }
      // ---------------- LinkedIn ----------------
      if (p === "/oauth/v2/authorization") {
        const q = rec.query;
        if (!q.state || q.response_type !== "code") return send(400, "state is required");
        const code = `licode-${randomBytes(8).toString("hex")}`;
        codes.set(code, { platform: "linkedin", clientId: q.client_id, redirectUri: q.redirect_uri, scope: q.scope });
        const back = new URL(q.redirect_uri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.state);
        return send(200, authorizePage("Authorize LinkedIn (mock)", back.toString()), {
          "content-type": "text/html",
        });
      }
      if (p === "/oauth/v2/accessToken") {
        const f = rec.form || {};
        const entry = codes.get(f.code);
        codes.delete(f.code);
        if (!entry || entry.platform !== "linkedin" || entry.redirectUri !== f.redirect_uri)
          return send(400, { error: "invalid_request", error_description: "Bad code" });
        if (!f.client_secret) return send(401, { error: "invalid_client", error_description: "Missing secret" });
        return send(200, issue("linkedin", entry.scope.replace(/ /g, ",")));
      }
      if (p === "/oauth/v2/revoke") {
        revoked.push(rec.form?.token || "");
        return send(200, "");
      }
      if ((p.startsWith("/v2/") || p.startsWith("/rest/") || p.startsWith("/upload/")) && !authed("linkedin"))
        return send(401, { status: 401, message: "Invalid access token" });
      if (p === "/v2/userinfo") return send(200, { ...LI_USER, email_verified: false });
      if (p.startsWith("/rest/")) {
        if (!req.headers["linkedin-version"] || req.headers["x-restli-protocol-version"] !== "2.0.0")
          return send(400, { message: "Missing LinkedIn-Version or X-Restli-Protocol-Version" });
      }
      if (p === "/rest/images" && rec.query.action === "initializeUpload") {
        const id = String(++seq);
        media.set(`urn:li:image:${id}`, { kind: "image", bytes: 0, segments: 0, statusChecks: 0 });
        return send(200, {
          value: { uploadUrlExpiresAt: Date.now() + 3600_000, uploadUrl: `${origin}/upload/image/${id}`, image: `urn:li:image:${id}` },
        });
      }
      m = p.match(/^\/upload\/image\/(\d+)$/);
      if (m && rec.method === "PUT") {
        const entry = media.get(`urn:li:image:${m[1]}`);
        if (!entry) return send(404, { message: "Unknown upload" });
        entry.bytes = raw.length;
        entry.segments = 1;
        return send(201, "");
      }
      if (p === "/rest/videos" && rec.query.action === "initializeUpload") {
        const size = Number(rec.json?.initializeUploadRequest?.fileSizeBytes);
        const id = String(++seq);
        const partSize = 4 * 1024 * 1024;
        const instructions = [];
        for (let first = 0, i = 0; first < size; first += partSize, i++)
          instructions.push({
            uploadUrl: `${origin}/upload/video/${id}/${i}`,
            firstByte: first,
            lastByte: Math.min(first + partSize, size) - 1,
          });
        media.set(`urn:li:video:${id}`, { kind: "video", bytes: 0, segments: 0, statusChecks: 0 });
        videoParts.set(id, { etags: [], size });
        return send(200, {
          value: { video: `urn:li:video:${id}`, uploadToken: `tok-${id}`, uploadInstructions: instructions },
        });
      }
      m = p.match(/^\/upload\/video\/(\d+)\/(\d+)$/);
      if (m && rec.method === "PUT") {
        const parts = videoParts.get(m[1]);
        if (!parts) return send(404, { message: "Unknown upload" });
        const etag = `etag-${m[1]}-${m[2]}`;
        parts.etags[Number(m[2])] = etag;
        media.get(`urn:li:video:${m[1]}`)!.bytes += raw.length;
        return send(200, "", { etag });
      }
      m = p.match(/^\/rest\/videos\/(.+)$/);
      if (m && rec.method === "GET") {
        const entry = media.get(decodeURIComponent(m[1]));
        if (!entry) return send(404, { message: "Unknown video" });
        entry.statusChecks++;
        const status = entry.statusChecks >= 2 ? state.linkedinVideoOutcome : "PROCESSING";
        return send(200, { id: decodeURIComponent(m[1]), status });
      }
      if (p === "/rest/videos" && rec.query.action === "finalizeUpload") {
        const r = rec.json?.finalizeUploadRequest || {};
        const id = String(r.video || "").split(":").at(-1)!;
        const parts = videoParts.get(id);
        if (!parts || JSON.stringify(parts.etags) !== JSON.stringify(r.uploadedPartIds))
          return send(400, { message: "Uploaded part ids do not match" });
        media.get(r.video)!.segments = parts.etags.length;
        return send(200, "");
      }
      if (p === "/rest/posts" && rec.method === "POST") {
        const b = rec.json || {};
        if (b.author !== `urn:li:person:${LI_USER.sub}`) return send(403, { message: "Not allowed to post as this author" });
        if (b.visibility !== "PUBLIC" || b.lifecycleState !== "PUBLISHED") return send(422, { message: "Invalid post" });
        const ids = [b.content?.media?.id, ...(b.content?.multiImage?.images || []).map((i: any) => i.id)].filter(Boolean);
        for (const id of ids) {
          const entry = media.get(id);
          if (!entry?.segments) return send(422, { message: `Media ${id} was not uploaded` });
          if (id.startsWith("urn:li:video:") && entry.statusChecks < 2)
            return send(422, { message: `Video ${id} is not AVAILABLE yet` });
        }
        const urn = `urn:li:share:${7_300_000_000_000_000_000n + BigInt(++seq)}`;
        linkedinPosts.push({ urn, body: b });
        return send(201, "", { "x-restli-id": urn });
      }
      return send(404, { detail: `Mock has no route ${rec.method} ${p}` });
    } catch (e) {
      return send(500, { detail: String(e) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    get linkedinVideoOutcome() {
      return state.linkedinVideoOutcome;
    },
    set linkedinVideoOutcome(v) {
      state.linkedinVideoOutcome = v;
    },
    requests,
    tweets,
    linkedinPosts,
    revoked,
    media,
    issued,
    expiresIn,
    fail(f) {
      failures.push({ times: 1, ...f });
    },
    count(method, path) {
      return requests.filter(
        (r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)),
      ).length;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
