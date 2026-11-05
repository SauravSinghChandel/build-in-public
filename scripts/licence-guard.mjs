#!/usr/bin/env node
// Fails when GSAP or Remotion appears anywhere in the lockfile. Both have licences
// that are incompatible with how BIP is distributed; HyperFrames is used instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = process.argv[2] || path.join(root, "pnpm-lock.yaml");
const banned = ["gsap", "remotion"];
let text;
try {
  text = fs.readFileSync(lockfile, "utf8");
} catch (e) {
  console.error(`Couldn't read ${lockfile}: ${e.message}. Run pnpm install first.`);
  process.exit(2);
}
const hits = [];
text.split("\n").forEach((line, i) => {
  for (const name of banned) {
    // Package keys and specifiers: gsap, gsap@3, @remotion/player, remotion@4 …
    const re = new RegExp(`(^|[\\s'"/(])@?${name}(@|/|['":\\s]|$)`, "i");
    if (re.test(line)) hits.push(`${path.basename(lockfile)}:${i + 1}: ${line.trim()}`);
  }
});
// HyperFrames vendors a GSAP build in its dist. BIP never loads it (compositions that
// reference gsap are rejected), so this is a warning for the licence docs, not a failure.
function vendoredGsap() {
  let dir;
  try {
    dir = path.dirname(
      createRequire(path.join(root, "apps/server/package.json")).resolve(
        "hyperframes/package.json",
      ),
    );
  } catch {
    return [];
  }
  const found = [];
  const walk = (d, depth) => {
    if (depth > 8) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (/^gsap@\d/.test(e.name)) found.push(p);
        else if (e.name !== "node_modules") walk(p, depth + 1);
      } else if (/^gsap(\.min)?\.js$/.test(e.name) && !found.some((f) => p.startsWith(f)))
        found.push(p);
    }
  };
  walk(dir, 0);
  return found.map((f) => path.relative(root, f));
}
for (const f of vendoredGsap())
  console.warn(
    `${process.env.GITHUB_ACTIONS ? "::warning::" : ""}WARNING: hyperframes vendors GSAP at ${f}. BIP never loads it (compositions reject gsap); keep docs/licenses.md accurate.`,
  );
if (hits.length) {
  console.error(
    `Licence guard failed: ${banned.join(" and ")} must not be dependencies.\n` +
      hits.slice(0, 20).join("\n") +
      "\nRemove the package (or the dependency that pulls it in), then run pnpm install.",
  );
  process.exit(1);
}
console.log(`Licence guard passed: no ${banned.join(" or ")} in ${path.basename(lockfile)}.`);
