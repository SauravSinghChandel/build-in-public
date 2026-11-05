import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountInfo, AccountsView, PlatformId } from "@bip/shared";
import {
  createSecretStore,
  FILE_STORE_WARNING,
  Scrubber,
  type SecretStore,
} from "./secrets.js";
import {
  endpoints as defaultEndpoints,
  LinkedInApi,
  pkce,
  PlatformError,
  SCOPES,
  sleep,
  XApi,
  type App,
  type Endpoints,
  type HttpOptions,
  type TokenSet,
} from "./platforms.js";

export const STATE_TTL_MS = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
interface Row {
  id: string;
  platform: PlatformId;
  handle: string;
  display_name: string | null;
  external_user_id: string;
  keychain_ref: string;
  scopes: string;
  expires_at: string | null;
  created_at: string;
}
interface Pending {
  platform: PlatformId;
  verifier?: string;
  nonceHash: string;
  createdAt: number;
}

/** "soon" within 7 days of expiry; LinkedIn shows "Reconnect by <date>". */
export function expiryStatus(expiresAt: string | null, now = Date.now()) {
  if (!expiresAt) return "ok" as const;
  const t = Date.parse(expiresAt);
  if (t <= now) return "expired" as const;
  return t - now < 7 * DAY ? ("soon" as const) : ("ok" as const);
}
const hash = (v: string) => createHash("sha256").update(v).digest();

export class Accounts {
  readonly scrubber = new Scrubber();
  private store?: SecretStore;
  private pending = new Map<string, Pending>();
  readonly ep: Endpoints;
  constructor(
    readonly db: Database.Database,
    readonly home: string,
    readonly port: number,
    private options: {
      secrets?: SecretStore;
      endpoints?: Endpoints;
      now?: () => number;
      backoffMs?: number;
      timeoutMs?: number;
      sleep?: HttpOptions["sleep"];
    } = {},
  ) {
    this.ep = options.endpoints ?? defaultEndpoints();
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  /** Chosen lazily so starting the server (and unrelated tests) never touches the keychain. */
  secrets() {
    this.store ??= this.options.secrets ?? createSecretStore(this.home);
    return this.store;
  }
  http(signal?: AbortSignal): HttpOptions {
    return {
      signal,
      backoffMs:
        this.options.backoffMs ?? (Number(process.env.BIP_PUBLISH_BACKOFF_MS) || 1000),
      sleep: this.options.sleep ?? sleep,
      timeoutMs: this.options.timeoutMs,
      scrub: (t) => this.scrubber.scrub(t),
    };
  }
  x(signal?: AbortSignal) {
    return new XApi(this.ep.x, this.http(signal));
  }
  linkedin(signal?: AbortSignal) {
    return new LinkedInApi(this.ep.linkedin, this.http(signal));
  }
  redirectUri(platform: PlatformId) {
    return `http://127.0.0.1:${this.port}/oauth/${platform}/callback`;
  }
  private secret(key: string) {
    const value = this.secrets().get(key);
    this.scrubber.add(value);
    return value;
  }
  private putSecret(key: string, value: string) {
    this.scrubber.add(value);
    this.secrets().set(key, value);
  }
  private dropSecret(key: string) {
    try {
      this.secrets().delete(key);
    } catch {
      /* already gone */
    }
  }
  // ---- developer app credentials ----
  app(platform: PlatformId): App | null {
    const row = this.db
      .prepare("SELECT client_id, secret_ref FROM platform_apps WHERE platform=?")
      .get(platform) as { client_id: string; secret_ref: string | null } | undefined;
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientSecret: row.secret_ref ? this.secret(row.secret_ref) : null,
    };
  }
  saveApp(platform: PlatformId, clientId: string, clientSecret?: string) {
    const ref = `${platform}:app:client_secret`;
    const existing = this.db
      .prepare("SELECT secret_ref FROM platform_apps WHERE platform=?")
      .get(platform) as { secret_ref: string | null } | undefined;
    let secretRef = existing?.secret_ref ?? null;
    if (clientSecret) {
      this.putSecret(ref, clientSecret);
      secretRef = ref;
    }
    if (platform === "linkedin" && !secretRef)
      throw Error("LinkedIn needs the client secret from your app's Auth tab");
    this.db
      .prepare(
        "INSERT INTO platform_apps(platform,client_id,secret_ref,updated_at) VALUES(?,?,?,?) ON CONFLICT(platform) DO UPDATE SET client_id=excluded.client_id, secret_ref=excluded.secret_ref, updated_at=excluded.updated_at",
      )
      .run(platform, clientId, secretRef, new Date().toISOString());
  }
  // ---- accounts ----
  private row(platform: PlatformId) {
    return this.db
      .prepare("SELECT * FROM accounts WHERE platform=?")
      .get(platform) as Row | undefined;
  }
  info(platform: PlatformId): AccountInfo | null {
    const r = this.row(platform);
    if (!r) return null;
    return {
      id: r.id,
      platform: r.platform,
      handle: r.handle,
      displayName: r.display_name ?? undefined,
      scopes: r.scopes.split(" ").filter(Boolean),
      expiresAt: r.expires_at,
      reconnectBy:
        r.platform === "linkedin" && r.expires_at ? r.expires_at : null,
      expiry:
        r.platform === "linkedin" ? expiryStatus(r.expires_at, this.now()) : "ok",
      createdAt: r.created_at,
    };
  }
  /** `withStore: false` reports only database metadata and never touches the keychain. */
  view(withStore = true): AccountsView {
    let kind: "keychain" | "file" = "file";
    if (withStore)
      try {
        kind = this.secrets().kind;
      } catch {
        /* forced keychain mode without a keychain: report the file fallback */
      }
    return {
      secretStore: withStore
        ? { kind, ...(kind === "file" ? { warning: FILE_STORE_WARNING } : {}) }
        : null,
      platforms: (["x", "linkedin"] as const).map((platform) => {
        const app = this.db
          .prepare("SELECT client_id, secret_ref FROM platform_apps WHERE platform=?")
          .get(platform) as { client_id: string; secret_ref: string | null } | undefined;
        return {
          platform,
          redirectUri: this.redirectUri(platform),
          scopes: SCOPES[platform],
          app: app ? { clientId: app.client_id, hasSecret: !!app.secret_ref } : null,
          account: this.info(platform),
        };
      }),
    };
  }
  /** Starts OAuth. Returns the authorize URL and a browser-binding nonce for a cookie. */
  begin(platform: PlatformId) {
    const app = this.app(platform);
    if (!app) throw Error("Save your app's Client ID first");
    if (platform === "linkedin" && !app.clientSecret)
      throw Error("LinkedIn needs the client secret from your app's Auth tab");
    const now = Date.now();
    for (const [k, v] of this.pending)
      if (now - v.createdAt > STATE_TTL_MS) this.pending.delete(k);
    while (this.pending.size >= 20) this.pending.delete(this.pending.keys().next().value!);
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const challenge = platform === "x" ? pkce() : undefined;
    this.pending.set(state, {
      platform,
      verifier: challenge?.verifier,
      nonceHash: hash(nonce).toString("hex"),
      createdAt: now,
    });
    const url =
      platform === "x"
        ? this.x().authorizeUrl(app, this.redirectUri(platform), state, challenge!.challenge)
        : this.linkedin().authorizeUrl(app, this.redirectUri(platform), state);
    return { url, nonce, state };
  }
  /** Validates and consumes `state` (single use, 10 minutes, bound to the browser nonce). */
  consume(platform: PlatformId, state: string | undefined, nonce: string | undefined) {
    const pending = state ? this.pending.get(state) : undefined;
    if (state) this.pending.delete(state);
    if (!pending || pending.platform !== platform)
      throw Error("This sign-in link is invalid or was already used. Connect again.");
    if (Date.now() - pending.createdAt > STATE_TTL_MS)
      throw Error("This sign-in link expired. Connect again.");
    const expected = Buffer.from(pending.nonceHash, "hex");
    if (!nonce || !timingSafeEqual(hash(nonce), expected))
      throw Error("Finish connecting in the same browser you started from.");
    if (platform === "x" && !pending.verifier) throw Error("Missing PKCE verifier");
    return pending;
  }
  async complete(
    platform: PlatformId,
    q: { code?: string; state?: string; error?: string; error_description?: string },
    nonce: string | undefined,
  ) {
    const pending = this.consume(platform, q.state, nonce);
    if (q.error)
      throw Error(
        q.error === "access_denied"
          ? "The connection was cancelled."
          : this.scrubber.scrub(q.error_description || q.error),
      );
    if (!q.code) throw Error("The platform did not return an authorization code");
    const app = this.app(platform)!;
    const redirect = this.redirectUri(platform);
    const tokens =
      platform === "x"
        ? await this.x().exchange(app, q.code, pending.verifier!, redirect)
        : await this.linkedin().exchange(app, q.code, redirect);
    this.scrubber.add(tokens.accessToken, tokens.refreshToken);
    const profile =
      platform === "x"
        ? await this.x().profile(tokens.accessToken)
        : await this.linkedin().profile(tokens.accessToken);
    const previous = this.row(platform);
    if (previous) this.forget(previous);
    const id = randomUUID(),
      ref = `${platform}:${id}`;
    this.saveTokens(ref, tokens);
    this.db
      .prepare(
        "INSERT INTO accounts(id,platform,handle,display_name,external_user_id,keychain_ref,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        platform,
        profile.handle,
        profile.displayName ?? null,
        profile.id,
        ref,
        (tokens.scopes.length ? tokens.scopes : SCOPES[platform]).join(" "),
        tokens.expiresAt,
        new Date().toISOString(),
      );
    return this.info(platform)!;
  }
  private saveTokens(ref: string, tokens: TokenSet) {
    this.putSecret(`${ref}:access_token`, tokens.accessToken);
    if (tokens.refreshToken) this.putSecret(`${ref}:refresh_token`, tokens.refreshToken);
  }
  private forget(row: Row) {
    this.dropSecret(`${row.keychain_ref}:access_token`);
    this.dropSecret(`${row.keychain_ref}:refresh_token`);
    this.db.prepare("DELETE FROM accounts WHERE id=?").run(row.id);
  }
  /** Revoke (where supported), delete secrets, delete the row. Revoke failures don't block. */
  async disconnect(platform: PlatformId) {
    const row = this.row(platform);
    if (!row) return { revoked: false };
    let revoked = false;
    try {
      const token = this.secret(`${row.keychain_ref}:access_token`);
      const app = this.app(platform);
      if (token && app) {
        await (platform === "x" ? this.x() : this.linkedin()).revoke(app, token);
        revoked = true;
      }
    } catch {
      revoked = false;
    }
    this.forget(row);
    return { revoked };
  }
  /** Access token for publishing; refreshes X tokens that are about to expire. */
  async token(platform: PlatformId, signal?: AbortSignal) {
    const row = this.row(platform);
    if (!row) throw new PlatformError(`Connect a ${platform === "x" ? "X" : "LinkedIn"} account in Settings → Accounts`);
    const access = this.secret(`${row.keychain_ref}:access_token`);
    if (!access)
      throw new PlatformError("Reconnect your account: its saved sign-in is missing.", 401);
    const expires = row.expires_at ? Date.parse(row.expires_at) : Infinity;
    if (expires - 60_000 > Date.now()) return { account: this.info(platform)!, row, token: access };
    if (platform === "linkedin")
      throw new PlatformError("Reconnect your account: the LinkedIn sign-in expired.", 401);
    const refresh = this.secret(`${row.keychain_ref}:refresh_token`);
    const app = this.app(platform);
    if (!refresh || !app)
      throw new PlatformError("Reconnect your account: the X sign-in expired.", 401);
    const next = await this.x(signal).refresh(app, refresh);
    this.saveTokens(row.keychain_ref, { ...next, refreshToken: next.refreshToken ?? refresh });
    this.db
      .prepare("UPDATE accounts SET expires_at=? WHERE id=?")
      .run(next.expiresAt, row.id);
    return { account: this.info(platform)!, row, token: next.accessToken };
  }
}
