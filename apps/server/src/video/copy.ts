import fs from "node:fs/promises";
import path from "node:path";
import { git } from "../git.js";
import { redact } from "../agents/context.js";

// Default video copy comes only from the user's own material (story, project, README, git log).
// BIP never invents marketing filler for captions, cards or callouts.

const NOT_A_SITE =
  /(?:github\.com|gitlab\.com|bitbucket\.org|shields\.io|badge|img\.|npmjs\.com|pypi\.org|localhost|127\.0\.0\.1|example\.(?:com|org)|travis-ci|circleci|codecov|readthedocs\.org\/projects|creativecommons\.org|opensource\.org|wikipedia\.org|youtube\.com|youtu\.be|twitter\.com|x\.com\/|linkedin\.com)/i;

/** The project's own website from a README, if one is stated (homepage/website/live/demo lines first). */
export function readmeWebsite(readme: string): string | undefined {
  const urls = (line: string) =>
    [...line.matchAll(/https?:\/\/[^\s)\]<>"'`]+/g)]
      .map((m) => m[0].replace(/[.,;:!?]+$/, ""))
      .filter(
        (u) => !NOT_A_SITE.test(u) && !/\.(?:png|jpe?g|gif|svg|webp)$/i.test(u),
      );
  const lines = readme.split("\n").slice(0, 200);
  const preferred = lines.filter((l) =>
    /\b(?:website|homepage|home page|live|demo|site|visit|try it)\b/i.test(l),
  );
  const found = [...preferred, ...lines].flatMap(urls)[0];
  if (!found) return undefined;
  const u = new URL(found);
  return (u.host + (u.pathname === "/" ? "" : u.pathname)).replace(
    /^www\./,
    "",
  );
}

/** Up to two caption texts from a story brief/angle, split on sentence boundaries. */
export function briefCaptions(brief: string): string[] {
  const text = brief.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const clip = (s: string) =>
    s.length > 200 ? s.slice(0, 199).trimEnd() + "…" : s;
  return sentences.slice(0, 2).map(clip);
}

/** First sentence of a brief, short enough for a title card. */
export function briefHeadline(brief: string) {
  const first = briefCaptions(brief)[0] || "";
  return first.length > 100 ? first.slice(0, 99).trimEnd() + "…" : first;
}

async function readRepoFile(repo: string, file: string) {
  const full = await fs.realpath(path.join(repo, file)).catch(() => null);
  if (!full || !(full === repo || full.startsWith(repo + path.sep))) return "";
  const fd = await fs.open(full, "r");
  try {
    const buffer = Buffer.alloc(64000);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fd.close();
  }
}

/** Outro text: the project name, plus the README's website on a second line when present. */
export async function outroNotes(repo: string, name: string) {
  const real = await fs.realpath(repo).catch(() => repo);
  let website: string | undefined;
  for (const file of ["README.md", "readme.md", "README"]) {
    const text = await readRepoFile(real, file).catch(() => "");
    if (text) {
      website = readmeWebsite(text);
      break;
    }
  }
  return website ? `${name}\n${website}` : name;
}

/** Terminal card text from the repository's actual recent history. */
export async function terminalNotes(repo: string, name: string) {
  const log = await git(repo, ["log", "--oneline", "--no-decorate", "-4"])
    .then((s) => s.trim())
    .catch(() => "");
  return log ? redact(`$ git log --oneline\n${log}`) : name;
}
