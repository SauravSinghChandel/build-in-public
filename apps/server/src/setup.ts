import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import { ensureConfig } from "./config.js";
import { agents } from "./doctor.js";
import { configPath, dataHome } from "./paths.js";
import { hyperframes } from "./video/process.js";
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
export const PNPM = "npx --yes pnpm@10.34.9";
export type OsFamily = "debian" | "fedora" | "arch" | "macos" | "other";
export function osFamily(
  platform = process.platform,
  osRelease = (() => {
    try {
      return readFileSync("/etc/os-release", "utf8");
    } catch {
      return "";
    }
  })(),
): OsFamily {
  if (platform === "darwin") return "macos";
  const ids = (
    /^ID=(.*)$/m.exec(osRelease)?.[1] +
    " " +
    (/^ID_LIKE=(.*)$/m.exec(osRelease)?.[1] || "")
  ).replace(/"/g, "");
  if (/\b(debian|ubuntu)\b/.test(ids)) return "debian";
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return "fedora";
  if (/\b(arch|manjaro)\b/.test(ids)) return "arch";
  return "other";
}
type Fixes = Partial<Record<OsFamily | "any", string>>;
const FIXES: Record<string, Fixes> = {
  node: {
    debian:
      "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs",
    fedora: "sudo dnf install -y nodejs22",
    arch: "sudo pacman -S --needed nodejs npm",
    macos: "brew install node@22",
  },
  git: {
    debian: "sudo apt-get install -y git",
    fedora: "sudo dnf install -y git",
    arch: "sudo pacman -S --needed git",
    macos: "brew install git",
  },
  ffmpeg: {
    debian: "sudo apt-get install -y ffmpeg",
    fedora: "sudo dnf install -y ffmpeg-free",
    arch: "sudo pacman -S --needed ffmpeg",
    macos: "brew install ffmpeg",
  },
  chromium: {
    any: "npx playwright install chromium",
    debian: "npx playwright install chromium && sudo npx playwright install-deps chromium",
  },
  hyperframes: { any: `${PNPM} install` },
  claude: {
    any: "npm install -g @anthropic-ai/claude-code, then run claude once to sign in",
  },
  codex: { any: "npm install -g @openai/codex, then run codex login" },
};
export function fixFor(key: string, family: OsFamily): string[] {
  const fixes = FIXES[key] || {};
  if (fixes[family]) return [fixes[family]!];
  if (family === "other") {
    const all = (["debian", "fedora", "arch", "macos"] as const)
      .filter((f) => fixes[f])
      .map((f) => `${f}: ${fixes[f]}`);
    if (all.length) return all;
  }
  return fixes.any ? [fixes.any] : [];
}
export interface SetupItem {
  key: string;
  name: string;
  ok: boolean;
  /** Part of the minimum needed to run BIP. */
  required: boolean;
  detail?: string;
}
async function runs(binary: string, args: string[]) {
  return exec(binary, args, { timeout: 10000 })
    .then((r) => r.stdout.split("\n")[0].trim())
    .catch(() => undefined);
}
const chromiumInstalled = () =>
  fs
    .access(chromium.executablePath())
    .then(() => true)
    .catch(() => false);
export async function setupChecks(home = dataHome()): Promise<SetupItem[]> {
  const items: SetupItem[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  items.push({
    key: "node",
    name: `Node ${process.versions.node}`,
    ok: major >= 22,
    required: true,
    detail: major >= 22 ? undefined : "Build in Public needs Node 22 or later.",
  });
  const git = await runs("git", ["--version"]);
  items.push({ key: "git", name: git || "git", ok: !!git, required: true });
  const ffmpeg = await runs("ffmpeg", ["-version"]);
  const ffprobe = await runs("ffprobe", ["-version"]);
  items.push({
    key: "ffmpeg",
    name: "ffmpeg and ffprobe",
    ok: !!ffmpeg && !!ffprobe,
    required: true,
    detail: ffmpeg && !ffprobe ? "ffprobe is missing." : undefined,
  });
  items.push({
    key: "chromium",
    name: "Playwright Chromium",
    ok: await chromiumInstalled(),
    required: true,
  });
  items.push({
    key: "hyperframes",
    name: "HyperFrames runtime",
    ok: await hyperframes(["--version"], home, home)
      .then((s) => s.includes("0.9.13"))
      .catch(() => false),
    required: false,
    detail: "Needed for video rendering.",
  });
  for (const a of await agents()) {
    const usable = a.installed && a.auth !== "not signed in";
    items.push({
      key: a.id,
      name: `${a.id}${a.version ? ` ${a.version}` : ""} (${a.installed ? a.auth : "not installed"})`,
      ok: usable,
      required: false,
      detail: a.installed && !usable ? a.hint : undefined,
    });
  }
  return items;
}
/** Node, git, ffmpeg, Chromium and at least one usable agent. */
export function minimumMet(items: SetupItem[]) {
  return (
    items.filter((i) => i.required).every((i) => i.ok) &&
    items.some((i) => (i.key === "claude" || i.key === "codex") && i.ok)
  );
}
async function installChromium(log: (s: string) => void) {
  const cli = path.join(
    path.dirname(require.resolve("playwright/package.json")),
    "cli.js",
  );
  log("Installing Playwright Chromium…");
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: "inherit",
    });
    child.once("exit", (c) => resolve(c ?? 1));
    child.once("error", () => resolve(1));
  });
  if (code !== 0) log("Chromium install failed. Run the command above by hand.");
  return code === 0;
}
export async function setup(
  options: {
    interactive?: boolean;
    yes?: boolean;
    log?: (s: string) => void;
    family?: OsFamily;
  } = {},
): Promise<number> {
  const log = options.log || ((s: string) => console.log(s));
  const interactive =
    options.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  const family = options.family || osFamily();
  log("Build in Public setup\n");
  const items = await setupChecks();
  const chromiumItem = items.find((i) => i.key === "chromium")!;
  if (!chromiumItem.ok) {
    let install = !!options.yes;
    if (!install && interactive) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(
        "Playwright Chromium is missing. Install it now with npx playwright install chromium? [y/N] ",
      );
      rl.close();
      install = /^y(es)?$/i.test(answer.trim());
    }
    if (install && (await installChromium(log)))
      chromiumItem.ok = await chromiumInstalled();
  }
  for (const i of items) {
    log(`${i.ok ? "✓" : i.required ? "✗" : "!"} ${i.name}`);
    if (i.ok) continue;
    if (i.detail) log(`    ${i.detail}`);
    for (const fix of fixFor(i.key, family)) log(`    Fix: ${fix}`);
  }
  const agentOk = items.some(
    (i) => (i.key === "claude" || i.key === "codex") && i.ok,
  );
  if (!agentOk)
    log(
      "\n✗ No agent is ready. Install and sign in to Claude Code or Codex (one is enough).",
    );
  const config = await ensureConfig();
  log(`\nConfig: ${configPath()}`);
  log(`App data: ${dataHome()}`);
  log(`Port: ${config.port}`);
  if (minimumMet(items)) {
    log(`\nReady. Start Build in Public with:\n  ${PNPM} start`);
    log(
      "(Use pnpm start instead if pnpm is already on your PATH via corepack enable.)",
    );
    return 0;
  }
  log(
    "\nSome required tools are missing. Run the fixes above, then run setup again:",
  );
  log(`  ${PNPM} run bootstrap`);
  return 1;
}
