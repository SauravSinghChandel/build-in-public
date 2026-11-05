import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configPath } from "./paths.js";
import { atomicJsonWrite } from "./bip/store.js";
const Config = z.strictObject({
  claudeBin: z.string().default("claude"),
  codexBin: z.string().default("codex"),
  chromiumPath: z.string().optional(),
  videoConfigHome: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(4310),
});
export function readConfig() {
  try {
    return Config.parse(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return Config.parse({});
    throw Error(
      `Could not read ${configPath()}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
export async function ensureConfig() {
  const value = readConfig();
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  try {
    await fs.access(configPath());
  } catch {
    await atomicJsonWrite(configPath(), value);
  }
  return value;
}
export function appPort() {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.BIP_PORT || readConfig().port);
}

export function binaryFor(id: "claude" | "codex") {
  return (
    process.env[id === "claude" ? "BIP_CLAUDE_BIN" : "BIP_CODEX_BIN"] ||
    readConfig()[id === "claude" ? "claudeBin" : "codexBin"]
  );
}
