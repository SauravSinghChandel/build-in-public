import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const SECRET_SERVICE = "build-in-public";

/** Minimal synchronous secret storage. Keys look like `<platform>:<accountId>:<kind>`. */
export interface SecretStore {
  readonly kind: "keychain" | "file";
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** The subset of `@napi-rs/keyring`'s Entry used here (lets tests inject a fake). */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}
export type EntryFactory = (service: string, account: string) => KeyringEntry;

export class KeychainStore implements SecretStore {
  readonly kind = "keychain" as const;
  constructor(private entry: EntryFactory) {}
  get(key: string) {
    return this.entry(SECRET_SERVICE, key).getPassword();
  }
  set(key: string, value: string) {
    this.entry(SECRET_SERVICE, key).setPassword(value);
  }
  delete(key: string) {
    this.entry(SECRET_SERVICE, key).deletePassword();
  }
  /** Round-trips a probe entry; throws when no keychain/secret service is reachable. */
  probe() {
    const key = `probe:${randomBytes(6).toString("hex")}`;
    this.set(key, "ok");
    try {
      if (this.get(key) !== "ok") throw Error("Keychain probe mismatch");
    } finally {
      this.delete(key);
    }
  }
}

/**
 * Fallback for hosts without a keychain (headless Linux): AES-256-GCM encrypted JSON
 * at `<appdata>/secrets.enc`, key in `<appdata>/secrets.key` (mode 0600). This keeps
 * tokens out of plain-text files and backups of the database, but anyone who can read
 * both files as your user can decrypt them.
 */
export class EncryptedFileStore implements SecretStore {
  readonly kind = "file" as const;
  readonly file: string;
  readonly keyFile: string;
  constructor(dir: string) {
    this.file = path.join(dir, "secrets.enc");
    this.keyFile = path.join(dir, "secrets.key");
  }
  private key() {
    try {
      const key = fs.readFileSync(this.keyFile);
      if (key.length !== 32) throw Error("Invalid secrets key file");
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
      const key = randomBytes(32);
      fs.writeFileSync(this.keyFile, key, { mode: 0o600, flag: "wx" });
      return key;
    }
  }
  private read(): Record<string, string> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    const box = JSON.parse(raw) as { v: 1; iv: string; tag: string; data: string };
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(box.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(box.data, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
  private write(values: Record<string, string>) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(values), "utf8"),
      cipher.final(),
    ]);
    const box = {
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(box), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  get(key: string) {
    return this.read()[key] ?? null;
  }
  set(key: string, value: string) {
    this.write({ ...this.read(), [key]: value });
  }
  delete(key: string) {
    const values = this.read();
    if (!(key in values)) return;
    delete values[key];
    this.write(values);
  }
}

export const FILE_STORE_WARNING =
  "No system keychain is available, so tokens are stored in an encrypted file in the app data folder. Anyone who can read your app data folder can decrypt them.";

function napiEntry(): EntryFactory {
  const require = createRequire(import.meta.url);
  const { Entry } = require("@napi-rs/keyring") as {
    Entry: new (service: string, account: string) => KeyringEntry;
  };
  return (service, account) => new Entry(service, account);
}

/**
 * Picks the keychain when it works, otherwise the encrypted file.
 * `BIP_SECRET_STORE=file` forces the fallback (tests, portable installs).
 */
export function createSecretStore(
  dir: string,
  options: { mode?: string; entry?: EntryFactory } = {},
): SecretStore {
  const mode = options.mode ?? process.env.BIP_SECRET_STORE ?? "auto";
  if (mode !== "file") {
    try {
      const store = new KeychainStore(options.entry ?? napiEntry());
      store.probe();
      return store;
    } catch {
      if (mode === "keychain") throw Error("The system keychain is unavailable");
    }
  }
  return new EncryptedFileStore(dir);
}

/** Removes live secrets and bearer-like credentials from text bound for logs, errors or responses. */
export class Scrubber {
  private values = new Set<string>();
  add(...secrets: (string | null | undefined)[]) {
    for (const s of secrets) if (s && s.length >= 6) this.values.add(s);
  }
  remove(...secrets: (string | null | undefined)[]) {
    for (const s of secrets) if (s) this.values.delete(s);
  }
  scrub(text: string) {
    let out = text;
    for (const v of [...this.values].sort((a, b) => b.length - a.length))
      out = out.split(v).join("[REDACTED]");
    return out
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [REDACTED]")
      .replace(
        /\b(access_token|refresh_token|client_secret|code_verifier|token)(["']?\s*[:=]\s*["']?)[^\s"'&,}]{6,}/gi,
        "$1$2[REDACTED]",
      );
  }
}
