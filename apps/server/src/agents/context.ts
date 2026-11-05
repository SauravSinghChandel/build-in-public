import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { git } from "../git.js";
import type { openProject } from "../bip/store.js";
const patterns = [
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /sk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /"private_key"\s*:\s*"[^"\n]+"/g,
];
export function redact(text: string, filename = "") {
  if (/(^|\/)(\.env(?:\.|$)|[^/]*\.(?:env|conf|config|ini)$)/i.test(filename))
    text = text.replace(
      /^([+-]?)([A-Z0-9_]+)=(?:"[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_\/+=:@-]{4,})$/gm,
      "$1$2=[REDACTED]",
    );
  for (const re of patterns) text = text.replace(re, "[REDACTED]");
  return text;
}
export function redactDiff(text: string) {
  let filename = "";
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++ b/")) filename = line.slice(6);
      return redact(line, filename);
    })
    .join("\n");
}
export function secretWarnings(text: string) {
  return redact(text) !== text
    ? ["Possible secret detected. Remove it before approving."]
    : [];
}
export function privateWarnings(text: string, notes: string) {
  return notes
    .split(/\r?\n/)
    .map((s) =>
      s
        .replace(/^[-*#\s]+/, "")
        .replace(
          /^(?:never mention|never name|avoid mentioning|do not mention|don.t mention)[:\s]+/i,
          "",
        )
        .trim(),
    )
    .filter(
      (s) =>
        s.length >= 3 &&
        s.toLowerCase() !== "private notes" &&
        text.toLowerCase().includes(s.toLowerCase()),
    );
}
export const skipFile = (file: string) =>
  /(^|\/)(node_modules|vendor|dist|build|coverage|generated|\.git|\.bip|\.next|target)(\/|$)|(?:^|\/)(?:pnpm-lock.yaml|package-lock.json|yarn.lock|Cargo.lock|poetry.lock)|\.(?:min\.js|map|lock)$|(?:^|\/)\.env(?:\.|$)/i.test(
    file,
  );
export function capDiff(diff: string) {
  let lines: string[] = [],
    count = 0,
    binary = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      count = 0;
      binary = false;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch"))
      binary = true;
    if (!binary && count++ < 120) lines.push(line);
  }
  return lines.join("\n");
}
// Bound memory while reading large diffs, rather than buffering git's entire output.
export function boundedDiff(
  repo: string,
  args: string[],
  cap = 32000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let pending = "",
      output = "",
      stderr = "",
      count = 0,
      binary = false,
      clipped = false;
    const line = (value: string) => {
      if (value.startsWith("diff --git")) {
        count = 0;
        binary = false;
      }
      if (
        value.startsWith("Binary files") ||
        value.startsWith("GIT binary patch")
      )
        binary = true;
      if (!binary && count++ < 120) output += value + "\n";
      if (Buffer.byteLength(output) >= cap) {
        clipped = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (clipped) return;
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf("\n")) >= 0 && !clipped) {
        line(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
      // Huge minified lines are generated content; do not let them grow the parser indefinitely.
      if (pending.length > 65536) {
        pending = "";
        binary = true;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Git diff timed out"));
    }, 10000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pending && !clipped) line(pending);
      if (code !== 0 && !clipped)
        reject(Error(stderr || "Could not read diff"));
      else resolve(output);
    });
  });
}
export async function buildContext(
  store: Awaited<ReturnType<typeof openProject>>,
  commits: string[],
  note = "",
) {
  const notes = await store.readContext();
  const read = async (file: string) => {
    const full = path.join(store.repo, file);
    const real = await fs.realpath(full).catch(() => null);
    if (
      !real ||
      !(real === store.repo || real.startsWith(store.repo + path.sep))
    )
      return "";
    const fd = await fs.open(real, "r");
    try {
      const buffer = Buffer.alloc(64000);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fd.close();
    }
  };
  let body = `Project: ${store.project.name}\nSettings: ${JSON.stringify(store.project.settings)}\nShareable notes:\n${notes.shareable.slice(0, 8000)}\nAuto summary:\n${(await read(".bip/auto-summary.md")).slice(0, 6000)}\nREADME:\n${(await read("README.md")).split("\n").slice(0, 80).join("\n").slice(0, 8000)}\nUser note:\n${note.slice(0, 4000)}\n`;
  for (const sha of commits) {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error("Invalid commit SHA");
    const names = (
      await git(store.repo, [
        "show",
        "--format=",
        "--numstat",
        "-z",
        "--no-renames",
        "--first-parent",
        sha,
      ])
    )
      .split("\0")
      .filter(Boolean)
      .flatMap((line) => {
        const [a, d, ...name] = line.split("\t");
        const file = name.join("\t");
        return a !== "-" && d !== "-" && file && !skipFile(file) ? [file] : [];
      })
      .slice(0, 500);
    const stat = await git(
      store.repo,
      names.length
        ? ["show", "--format=fuller", "--stat", sha, "--", ...names]
        : ["show", "-s", "--format=fuller", sha],
    );
    const diff = names.length
      ? await boundedDiff(store.repo, [
          "show",
          "--format=",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--unified=3",
          sha,
          "--",
          ...names,
        ])
      : "";
    body += `\nCommit ${sha}\n${stat}\n${redactDiff(diff)}\n`;
    if (Buffer.byteLength(body) > 34000) break;
  }
  // Redact before truncating: otherwise a boundary could expose half a credential.
  const bounded = Buffer.from(redact(body)).subarray(0, 34000).toString("utf8");
  const privateData = Buffer.from(redact(notes.private))
    .subarray(0, 5000)
    .toString("utf8");
  return redact(
    `${bounded}\nNever mention (private exclusion data, never repeat):\n${privateData}`,
  );
}
