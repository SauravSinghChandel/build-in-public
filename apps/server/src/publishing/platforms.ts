import { createHash, randomBytes } from "node:crypto";
import type { PlatformId } from "@bip/shared";

export const SCOPES: Record<PlatformId, string[]> = {
  x: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  linkedin: ["openid", "profile", "w_member_social"],
};
export const PLATFORM_NAME: Record<PlatformId, string> = {
  x: "X",
  linkedin: "LinkedIn",
};

/** Base URLs are configurable so tests talk to a local mock and never to X/LinkedIn. */
export function endpoints(env: NodeJS.ProcessEnv = process.env) {
  return {
    x: {
      api: env.BIP_X_API_BASE || "https://api.x.com",
      auth: env.BIP_X_AUTH_BASE || "https://x.com",
    },
    linkedin: {
      api: env.BIP_LINKEDIN_API_BASE || "https://api.linkedin.com",
      auth: env.BIP_LINKEDIN_AUTH_BASE || "https://www.linkedin.com",
      version: env.BIP_LINKEDIN_VERSION || "202510",
    },
  };
}
export type Endpoints = ReturnType<typeof endpoints>;

export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}
export function challengeFor(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The request was sent but the outcome is unknown (create may have succeeded). */
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export const mayHavePosted = (platform: PlatformId) =>
  `${PLATFORM_NAME[platform]} returned an error after we sent the post. Check your profile before retrying.`;

export interface HttpOptions {
  signal?: AbortSignal;
  backoffMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  scrub: (text: string) => string;
  /** Longest single rate-limit wait before giving up with a "try again after" message. */
  maxWaitMs?: number;
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
}
export interface Call {
  platform: PlatformId;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Scope named in the 403 message for this operation. */
  scope: string;
  /**
   * Creates content: never retried after 5xx/timeout/network errors (it may already
   * exist); those fail as "may have posted". 429 is still retried (not processed).
   */
  creates?: boolean;
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Error("Cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(t);
      reject(Error("Cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function platformMessage(body: any): string {
  if (!body || typeof body !== "object") return "";
  return String(
    body.detail ||
      body.error_description ||
      body.message ||
      body.errors?.[0]?.message ||
      body.title ||
      (typeof body.error === "string" ? body.error : "") ||
      "",
  );
}

export function retryDelay(res: Response, attempt: number, base: number) {
  const backoff = base * 2 ** attempt;
  const reset = Number(res.headers.get("x-rate-limit-reset"));
  if (reset) return Math.max(reset * 1000 - Date.now(), backoff);
  const after = res.headers.get("retry-after");
  if (after !== null && after !== "") {
    const seconds = Number(after);
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(after) - Date.now();
    if (Number.isFinite(ms)) return Math.max(ms, backoff);
  }
  return backoff;
}

/**
 * Sends one platform request. 429 waits for the reset/Retry-After (with exponential
 * backoff); 5xx, timeouts and network errors retry, except for content-creating calls
 * (see `Call.creates`). At most 3 retries. Other failures map to actionable messages.
 */
export async function send(call: Call, http: HttpOptions): Promise<Response> {
  const name = PLATFORM_NAME[call.platform];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    const timeout = AbortSignal.timeout(http.timeoutMs ?? 60_000);
    try {
      res = await fetch(call.url, {
        method: call.method,
        headers: call.headers,
        body: call.body,
        signal: http.signal ? AbortSignal.any([http.signal, timeout]) : timeout,
        redirect: "error",
      });
    } catch (e) {
      if (http.signal?.aborted) throw Error("Cancelled");
      if (call.creates)
        throw new PlatformError(mayHavePosted(call.platform), undefined, true);
      if (attempt < 3) {
        await http.sleep(http.backoffMs * 2 ** attempt, http.signal);
        continue;
      }
      throw new PlatformError(
        http.scrub(
          timeout.aborted
            ? `${name} did not respond in time. Try again later.`
            : `Could not reach ${name}: ${(e as Error).message}`,
        ),
      );
    }
    if (res.ok) return res;
    if (call.creates && res.status >= 500) {
      await res.body?.cancel();
      throw new PlatformError(mayHavePosted(call.platform), res.status, true);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = retryDelay(res, attempt, http.backoffMs);
      if (wait > (http.maxWaitMs ?? 5 * 60 * 1000)) {
        await res.body?.cancel();
        throw new PlatformError(
          `${name} rate limit reached. Try again after ${new Date(Date.now() + wait).toLocaleTimeString()}.`,
          429,
        );
      }
      await res.body?.cancel();
      await http.sleep(wait, http.signal);
      continue;
    }
    throw await mapError(res, call, http.scrub);
  }
}

async function mapError(res: Response, call: Call, scrub: (t: string) => string) {
  const name = PLATFORM_NAME[call.platform];
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const detail = scrub(platformMessage(body) || text.slice(0, 300)).trim();
  if (res.status === 401)
    return new PlatformError(
      `Reconnect your account: ${name} rejected the saved sign-in. Open Settings → Accounts and connect again.`,
      401,
    );
  if (res.status === 403)
    return new PlatformError(
      `Your app is missing permission ${call.scope}.${detail ? ` ${name} said: ${detail}` : ""}`,
      403,
    );
  if (res.status === 429)
    return new PlatformError(
      `${name} is rate limiting requests. Try again later.`,
      429,
    );
  if (res.status >= 500)
    return new PlatformError(
      `${name} is having problems (${res.status}). Try again later.`,
      res.status,
    );
  return new PlatformError(
    detail ? `${name}: ${detail}` : `${name} returned ${res.status}`,
    res.status,
  );
}

export async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopes: string[];
}
export interface App {
  clientId: string;
  clientSecret?: string | null;
}
export interface Profile {
  id: string;
  handle: string;
  displayName?: string;
}
export interface MediaFile {
  bytes: Buffer;
  mime: string;
  alt?: string;
}

function tokens(body: any): TokenSet {
  if (!body.access_token) throw new PlatformError("No access token returned");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: body.expires_in
      ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString()
      : null,
    scopes: String(body.scope || "")
      .split(/[\s,]+/)
      .filter(Boolean),
  };
}
const form = (v: Record<string, string>) => new URLSearchParams(v).toString();
const formHeaders = (app: App) => ({
  "content-type": "application/x-www-form-urlencoded",
  ...(app.clientSecret
    ? {
        authorization:
          "Basic " +
          Buffer.from(
            `${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`,
          ).toString("base64"),
      }
    : {}),
});

export class XApi {
  constructor(
    private ep: Endpoints["x"],
    private http: HttpOptions,
    private chunkBytes = Number(process.env.BIP_X_CHUNK_BYTES) || 4 * 1024 * 1024,
  ) {}
  private call(c: Omit<Call, "platform">) {
    return send({ ...c, platform: "x" }, this.http);
  }
  authorizeUrl(app: App, redirectUri: string, state: string, challenge: string) {
    const u = new URL("/i/oauth2/authorize", this.ep.auth);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: app.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.x.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }
  async exchange(app: App, code: string, verifier: string, redirectUri: string) {
    const res = await this.call({
      method: "POST",
      url: this.ep.api + "/2/oauth2/token",
      headers: formHeaders(app),
      body: form({
        code,
        grant_type: "authorization_code",
        client_id: app.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      scope: "offline.access",
    });
    return tokens(await json(res));
  }
  async refresh(app: App, refreshToken: string) {
    const res = await this.call({
      method: "POST",
      url: this.ep.api + "/2/oauth2/token",
      headers: formHeaders(app),
      body: form({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        client_id: app.clientId,
      }),
      scope: "offline.access",
    });
    return tokens(await json(res));
  }
  async revoke(app: App, token: string) {
    await this.call({
      method: "POST",
      url: this.ep.api + "/2/oauth2/revoke",
      headers: formHeaders(app),
      body: form({
        token,
        token_type_hint: "access_token",
        client_id: app.clientId,
      }),
      scope: "offline.access",
    });
  }
  async profile(token: string): Promise<Profile> {
    const res = await this.call({
      method: "GET",
      url: this.ep.api + "/2/users/me",
      headers: { authorization: `Bearer ${token}` },
      scope: "users.read",
    });
    const { data } = await json(res);
    return { id: String(data.id), handle: data.username, displayName: data.name };
  }
  async upload(token: string, file: MediaFile) {
    const auth = { authorization: `Bearer ${token}` };
    let id: string;
    if (file.mime.startsWith("image/")) {
      const body = new FormData();
      body.append("media", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), "image");
      body.append("media_category", "tweet_image");
      body.append("media_type", file.mime);
      const res = await this.call({
        method: "POST",
        url: this.ep.api + "/2/media/upload",
        headers: auth,
        body,
        scope: "media.write",
      });
      id = String((await json(res)).data.id);
    } else {
      const init = await this.call({
        method: "POST",
        url: this.ep.api + "/2/media/upload/initialize",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          media_type: file.mime,
          total_bytes: file.bytes.length,
          media_category: "tweet_video",
        }),
        scope: "media.write",
      });
      id = String((await json(init)).data.id);
      for (let i = 0, o = 0; o < file.bytes.length; i++, o += this.chunkBytes) {
        const body = new FormData();
        body.append("segment_index", String(i));
        body.append(
          "media",
          new Blob([new Uint8Array(file.bytes.subarray(o, o + this.chunkBytes))]),
          "chunk",
        );
        await this.call({
          method: "POST",
          url: `${this.ep.api}/2/media/upload/${encodeURIComponent(id)}/append`,
          headers: auth,
          body,
          scope: "media.write",
        });
      }
      const fin = await this.call({
        method: "POST",
        url: `${this.ep.api}/2/media/upload/${encodeURIComponent(id)}/finalize`,
        headers: auth,
        scope: "media.write",
      });
      let info = (await json(fin)).data?.processing_info;
      for (let n = 0; info && !["succeeded"].includes(info.state); n++) {
        if (info.state === "failed")
          throw new PlatformError(
            `X could not process the video${info.error?.message ? `: ${info.error.message}` : ""}`,
          );
        if (n >= 60) throw new PlatformError("X is still processing the video. Retry later.");
        await this.http.sleep(
          Math.min(Number(info.check_after_secs || 1), 10) * 1000,
          this.http.signal,
        );
        const status = await this.call({
          method: "GET",
          url: `${this.ep.api}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`,
          headers: auth,
          scope: "media.write",
        });
        info = (await json(status)).data?.processing_info;
      }
    }
    if (file.alt && file.mime.startsWith("image/"))
      await this.call({
        method: "POST",
        url: this.ep.api + "/2/media/metadata",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ id, metadata: { alt_text: { text: file.alt.slice(0, 1000) } } }),
        scope: "media.write",
      });
    return id;
  }
  async createPost(
    token: string,
    input: { text: string; mediaIds: string[]; replyTo?: string },
  ) {
    const res = await this.call({
      method: "POST",
      url: this.ep.api + "/2/tweets",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        ...(input.mediaIds.length ? { media: { media_ids: input.mediaIds } } : {}),
        ...(input.replyTo ? { reply: { in_reply_to_tweet_id: input.replyTo } } : {}),
      }),
      scope: "tweet.write",
      creates: true,
    });
    const id = (await json(res)).data?.id;
    if (!id) throw new PlatformError("X did not return a post id");
    return String(id);
  }
}

export class LinkedInApi {
  constructor(
    private ep: Endpoints["linkedin"],
    private http: HttpOptions,
  ) {}
  private call(c: Omit<Call, "platform">) {
    return send({ ...c, platform: "linkedin" }, this.http);
  }
  private rest(token: string, extra: Record<string, string> = {}) {
    return {
      authorization: `Bearer ${token}`,
      "LinkedIn-Version": this.ep.version,
      "X-Restli-Protocol-Version": "2.0.0",
      ...extra,
    };
  }
  authorizeUrl(app: App, redirectUri: string, state: string) {
    const u = new URL("/oauth/v2/authorization", this.ep.auth);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: app.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.linkedin.join(" "),
      state,
    }).toString();
    return u.toString();
  }
  async exchange(app: App, code: string, redirectUri: string) {
    if (!app.clientSecret) throw new PlatformError("LinkedIn needs a client secret");
    const res = await this.call({
      method: "POST",
      url: this.ep.auth + "/oauth/v2/accessToken",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: app.clientId,
        client_secret: app.clientSecret,
      }),
      scope: "w_member_social",
    });
    return tokens(await json(res));
  }
  async revoke(app: App, token: string) {
    if (!app.clientSecret) return;
    await this.call({
      method: "POST",
      url: this.ep.auth + "/oauth/v2/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: app.clientId, client_secret: app.clientSecret, token }),
      scope: "w_member_social",
    });
  }
  async profile(token: string): Promise<Profile> {
    const res = await this.call({
      method: "GET",
      url: this.ep.api + "/v2/userinfo",
      headers: { authorization: `Bearer ${token}` },
      scope: "openid profile",
    });
    const body = await json(res);
    if (!body.sub) throw new PlatformError("LinkedIn did not return a member id");
    return { id: String(body.sub), handle: body.name || body.sub, displayName: body.name };
  }
  /** Upload URLs come from LinkedIn; only send the token to LinkedIn (or the configured base). */
  private uploadUrl(value: string) {
    const u = new URL(value);
    const trusted = [this.ep.api, this.ep.auth].map((b) => new URL(b).origin);
    if (
      trusted.includes(u.origin) ||
      (u.protocol === "https:" && /(^|\.)linkedin\.com$|(^|\.)licdn\.com$/.test(u.hostname))
    )
      return u.toString();
    throw new PlatformError("LinkedIn returned an unexpected upload address");
  }
  async upload(token: string, owner: string, file: MediaFile) {
    if (file.mime.startsWith("image/")) {
      const init = await this.call({
        method: "POST",
        url: this.ep.api + "/rest/images?action=initializeUpload",
        headers: this.rest(token, { "content-type": "application/json" }),
        body: JSON.stringify({ initializeUploadRequest: { owner } }),
        scope: "w_member_social",
      });
      const { value } = await json(init);
      await this.call({
        method: "PUT",
        url: this.uploadUrl(value.uploadUrl),
        headers: { authorization: `Bearer ${token}`, "content-type": file.mime },
        body: new Uint8Array(file.bytes),
        scope: "w_member_social",
      });
      return String(value.image);
    }
    const init = await this.call({
      method: "POST",
      url: this.ep.api + "/rest/videos?action=initializeUpload",
      headers: this.rest(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner,
          fileSizeBytes: file.bytes.length,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
      scope: "w_member_social",
    });
    const { value } = await json(init);
    const etags: string[] = [];
    for (const part of value.uploadInstructions as {
      uploadUrl: string;
      firstByte: number;
      lastByte: number;
    }[]) {
      const res = await this.call({
        method: "PUT",
        url: this.uploadUrl(part.uploadUrl),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: new Uint8Array(file.bytes.subarray(part.firstByte, part.lastByte + 1)),
        scope: "w_member_social",
      });
      const etag = res.headers.get("etag");
      await res.body?.cancel();
      if (!etag) throw new PlatformError("LinkedIn did not confirm a video part");
      etags.push(etag);
    }
    await this.call({
      method: "POST",
      url: this.ep.api + "/rest/videos?action=finalizeUpload",
      headers: this.rest(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: value.video,
          uploadToken: value.uploadToken || "",
          uploadedPartIds: etags,
        },
      }),
      scope: "w_member_social",
    });
    await this.videoReady(token, String(value.video));
    return String(value.video);
  }
  /** Waits until LinkedIn reports the video AVAILABLE (posting earlier fails). */
  async videoReady(token: string, urn: string, attempts = 60) {
    for (let n = 0; ; n++) {
      const res = await this.call({
        method: "GET",
        url: `${this.ep.api}/rest/videos/${encodeURIComponent(urn)}`,
        headers: this.rest(token),
        scope: "w_member_social",
      });
      const status = String((await json(res)).status || "");
      if (status === "AVAILABLE") return;
      if (status === "PROCESSING_FAILED")
        throw new PlatformError("LinkedIn could not process the video.");
      if (n + 1 >= attempts)
        throw new PlatformError("LinkedIn is still processing the video. Retry later.");
      await this.http.sleep(5000, this.http.signal);
    }
  }
  async createPost(
    token: string,
    input: { author: string; text: string; media: { id: string; alt?: string }[] },
  ) {
    const content =
      input.media.length === 1
        ? { media: { id: input.media[0].id, ...(input.media[0].alt ? { altText: input.media[0].alt } : {}) } }
        : input.media.length > 1
          ? {
              multiImage: {
                images: input.media.map((m) => ({ id: m.id, ...(m.alt ? { altText: m.alt } : {}) })),
              },
            }
          : undefined;
    const res = await this.call({
      method: "POST",
      url: this.ep.api + "/rest/posts",
      creates: true,
      headers: this.rest(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        author: input.author,
        commentary: input.text,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(content ? { content } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      scope: "w_member_social",
    });
    const urn = res.headers.get("x-restli-id") || (await json(res).catch(() => ({}))).id;
    if (!urn) throw new PlatformError("LinkedIn did not return a post id");
    return String(urn);
  }
}
