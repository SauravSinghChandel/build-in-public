import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { readConfig } from "../config.js";
export async function command(
  bin: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onData?: (s: string) => void;
    timeout?: number;
  } = {},
) {
  options.signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          "SIGKILL",
        );
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(kill, options.timeout || 300000);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    const data = (b: Buffer) => {
      const s = String(b);
      output = (output + s).slice(-2000000);
      options.onData?.(s);
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.on("error", (e) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      code === 0
        ? resolve(output)
        : reject(Error(`${bin} exited ${code}: ${output.slice(-8000)}`));
    });
  });
}
export function browserPath() {
  const configured =
    process.env.HYPERFRAMES_BROWSER_PATH || readConfig().chromiumPath;
  if (configured) return configured;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), ".cache/ms-playwright");
  // Use the installed cached Chromium when the Playwright package revision is newer.
  const dirs = existsSync(cache) ? requireFs(cache) : [];
  for (const dir of dirs.sort().reverse()) {
    const candidate = path.join(cache, dir, "chrome-linux64/chrome");
    if (dir.startsWith("chromium-") && existsSync(candidate)) return candidate;
  }
  return chromium.executablePath();
}
import { readdirSync as requireFs } from "node:fs";
export const hyperframesCli = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("hyperframes/package.json"),
  ),
  "bin/hyperframes.mjs",
);
export async function hyperframes(
  args: string[],
  cwd: string,
  home: string,
  signal?: AbortSignal,
  onData?: (s: string) => void,
) {
  const configHome =
    readConfig().videoConfigHome || path.join(home, "hyperframes-config");
  await fs.mkdir(configHome, { recursive: true });
  return command(process.execPath, [hyperframesCli, ...args], {
    cwd,
    signal,
    onData,
    env: {
      ...process.env,
      HYPERFRAMES_BROWSER_PATH: browserPath(),
      XDG_CONFIG_HOME: configHome,
      HYPERFRAMES_NO_TELEMETRY: "1",
    },
  });
}
export async function probe(file: string) {
  const data = JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
  const video = data.streams.find((s: any) => s.codec_type === "video");
  const durationMs = Number(data.format.duration) * 1000;
  if (
    !video ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    video.width * video.height > 40000000
  )
    throw Error("Invalid video or dimensions");
  return {
    width: video.width as number,
    height: video.height as number,
    durationMs,
    codec: video.codec_name as string,
    fps: video.r_frame_rate as string,
    format: data.format.format_name as string,
    mime: (data.format.format_name.includes("webm")
      ? "video/webm"
      : String(data.format.tags?.major_brand || "").trim() === "qt"
        ? "video/quicktime"
        : "video/mp4") as "video/mp4" | "video/webm" | "video/quicktime",
    hasAudio: data.streams.some((s: any) => s.codec_type === "audio"),
  };
}
