import fs from "node:fs/promises";
import path from "node:path";
import { VideoComposition } from "@bip/shared";
import { fileURLToPath } from "node:url";
import { hyperframes } from "./process.js";
/** Bundled IBM Plex (SIL OFL, see fonts/OFL.txt), staged next to every lint/render as trusted files. */
export const fontDir = fileURLToPath(
  new URL("../../../../packages/templates/video/fonts/", import.meta.url),
);
export const FONT_FILES = [
  ["IBM Plex Sans", 400, "ibm-plex-sans-latin-400-normal.woff2"],
  ["IBM Plex Sans", 600, "ibm-plex-sans-latin-600-normal.woff2"],
  ["IBM Plex Mono", 400, "ibm-plex-mono-latin-400-normal.woff2"],
] as const;
const fontFaces =
  FONT_FILES.map(
    ([family, , file]) =>
      `<link rel="preload" href="bip-fonts/${file}" as="font" type="font/woff2" crossorigin>`,
  ).join("") +
  `<style data-bip-fonts>${FONT_FILES.map(
    ([family, weight, file]) =>
      `@font-face{font-family:'${family}';src:url('bip-fonts/${file}') format('woff2');font-weight:${weight};font-style:normal;font-display:block}`,
  ).join("")}</style>`;
/** Copies the bundled fonts into a staging directory (never into the composition itself). */
export async function stageFonts(dir: string) {
  await fs.mkdir(path.join(dir, "bip-fonts"), { recursive: true });
  for (const [, , file] of FONT_FILES)
    await fs.copyFile(
      path.join(fontDir, file),
      path.join(dir, "bip-fonts", file),
    );
}
export function renderHtml(html: string) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
  return html.replace(/<head\b[^>]*>/i, (match) => match + csp + fontFaces);
}
export async function validateVideo(
  dir: string,
  home: string,
  lint = true,
  signal?: AbortSignal,
  sources = new Map<string, string>(),
) {
  const errors: string[] = [];
  for (const file of ["composition.json", "index.html", "styles.css"]) {
    const stat = await fs.lstat(path.join(dir, file)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink())
      errors.push("Required composition file missing or unsafe: " + file);
  }
  for (const name of await fs.readdir(dir)) {
    if (name === ".git") continue;
    const stat = await fs.lstat(path.join(dir, name));
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !["composition.json", "index.html", "styles.css", "motion.js"].includes(
        name,
      )
    ) {
      errors.push(`Disallowed composition file: ${name}`);
      continue;
    }
    if (stat.size > 8 * 1024 * 1024) {
      errors.push(`${name} exceeds 8 MB`);
      continue;
    }
    const text = await fs.readFile(path.join(dir, name), "utf8");
    if (name === "index.html") {
      const head = text.search(/<head\b[^>]*>/i),
        script = text.search(/<script\b/i);
      if (head < 0 || (script >= 0 && script < head))
        errors.push("Video HTML must have a head before any script");
    }
    if (/gsap|__timelines/i.test(text))
      errors.push(
        `GSAP is forbidden in Video Studio (${name}). Use CSS or WAAPI.`,
      );
    if (
      name !== "composition.json" &&
      /(?:https?:|ftp:|file:|javascript:|\/\/[^\s<]|@import|(?:src|href)\s*=\s*["']?\s*\/)/i.test(
        text,
      )
    )
      errors.push(`External URLs are forbidden (${name})`);
    if (
      name !== "composition.json" &&
      /(?:\.\.\/|<base\b|<form\b|<iframe|<object|<embed|fetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(|\beval\s*\(|new\s+Function)/i.test(
        text,
      )
    )
      errors.push(`Unsupported active resource (${name})`);
  }
  try {
    const config = VideoComposition.parse(
      JSON.parse(await fs.readFile(path.join(dir, "composition.json"), "utf8")),
    );
    if (lint) {
      const html = await fs.readFile(path.join(dir, "index.html"), "utf8"),
        root =
          /<[^>]+\bdata-composition-id=["']main["'][^>]*>/i.exec(html)?.[0] ||
          "";
      const duration = Number(
          /\bdata-duration=["']([^"']+)["']/i.exec(root)?.[1],
        ),
        fps = Number(/\bdata-fps=["']([^"']+)["']/i.exec(root)?.[1]);
      if (
        !root ||
        !Number.isFinite(duration) ||
        Math.abs(duration * 1000 - config.durationMs) > 1 ||
        fps !== 30
      )
        errors.push("HTML root duration/fps must match composition.json");
      for (let i = 0; i < config.captions.length; i++)
        if (!new RegExp(`\\bid=["']caption-${i}["']`).test(html))
          errors.push(`Caption ${i + 1} slot is missing from HTML`);
    }
  } catch (e) {
    errors.push(String(e));
  }
  if (!errors.length && lint) {
    await fs.mkdir(home, { recursive: true });
    const stage = await fs.mkdtemp(path.join(home, "video-lint-"));
    try {
      for (const name of await fs.readdir(dir))
        if (name !== ".git")
          await fs.copyFile(path.join(dir, name), path.join(stage, name));
      if (sources.size) {
        await fs.mkdir(path.join(stage, "assets"));
        for (const [sha, file] of sources)
          await fs.copyFile(file, path.join(stage, "assets", sha));
      }
      await stageFonts(stage);
      await fs.writeFile(
        path.join(stage, "index.html"),
        renderHtml(await fs.readFile(path.join(stage, "index.html"), "utf8")),
      );
      await hyperframes(["lint", "--json"], stage, home, signal);
    } catch (e) {
      errors.push(String(e));
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  return errors;
}
