#!/usr/bin/env node
// Creates a throwaway demo repository ("Shiplog", a tiny static web app) with 12 commits
// across 4 days, so you can try stories, image capture and video recording in Build in
// Public without touching your own repositories.
//
// Usage: pnpm demo:create [target-dir] [--port 4321]
//   target-dir defaults to a new folder under your temp directory.
//   The repo is created at <target-dir>/shiplog.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: pnpm demo:create [target-dir] [--port 4321]");
  process.exit(0);
}
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args.splice(portAt, 2)[1]) : 4321;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("--port must be a number from 1 to 65535.");
  process.exit(1);
}
const parent = args[0]
  ? path.resolve(args[0])
  : fs.mkdtempSync(path.join(os.tmpdir(), "bip-demo-"));
const repo = path.join(parent, "shiplog");
if (fs.existsSync(repo) && fs.readdirSync(repo).length) {
  console.error(
    `${repo} already exists and isn't empty. Choose another folder or delete it first.`,
  );
  process.exit(1);
}
fs.mkdirSync(repo, { recursive: true });

// Each file is a list of chunks; a chunk is present from commit `from` until before commit `to`.
const chunk = (from, text, to = Infinity) => ({ from, to, text });
const files = {
  "README.md": [
    chunk(2, `# Shiplog

A tiny static web app for logging what you shipped each day.

## Run it

    node serve.mjs

Then open http://127.0.0.1:${port}.
`),
    chunk(9, `
## Shortcuts

- \`N\` focuses the input.
`),
  ],
  "serve.mjs": [
    chunk(2, `#!/usr/bin/env node
// Zero-dependency static server: node serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || ${port});
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = path.join(root, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log("Shiplog running at http://127.0.0.1:" + port));
`),
  ],
  "index.html": [
    chunk(1, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shiplog</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <header>
      <h1>Shiplog</h1>
`),
    chunk(7, `      <span id="streak" class="streak" aria-live="polite">0-day streak</span>
`),
    chunk(10, `      <button id="theme" type="button" aria-label="Toggle dark mode">◐</button>
`),
    chunk(1, `    </header>
`),
    chunk(1, `    <p class="lede">What did you ship today?</p>
`, 12),
    chunk(12, `    <p class="lede">Log one thing you shipped today. Small things count.</p>
`),
    chunk(4, `    <form id="log">
      <label for="entry">What you shipped</label>
      <input id="entry" autocomplete="off" placeholder="Fixed the flaky login test">
      <button id="go" type="submit">Ship it</button>
    </form>
`),
    chunk(3, `    <ul id="entries"></ul>
`),
    chunk(5, `    <p id="empty" class="empty">Nothing logged yet. Your first entry starts a streak.</p>
`),
    chunk(11, `    <div id="burst" class="burst" aria-hidden="true"></div>
`),
    chunk(1, `  </main>
`),
    chunk(3, `  <script src="app.js"></script>
`),
    chunk(1, `</body>
</html>
`),
  ],
  "style.css": [
    chunk(1, `:root { --bg: #f7f5f0; --ink: #1d1b16; --muted: #5e5a50; --accent: #d9480f; --card: #fff; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
main { max-width: 560px; margin: 64px auto; padding: 0 16px; }
header { display: flex; align-items: center; gap: 12px; }
h1 { margin: 0; font-size: 28px; flex: 1; }
.lede { color: var(--muted); }
`),
    chunk(4, `form { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 24px 0; }
form label { grid-column: 1 / -1; font-weight: 600; }
input { padding: 10px 12px; border: 1px solid #ccc5b5; border-radius: 6px; font: inherit; }
button { padding: 10px 16px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
`),
    chunk(5, `.empty { color: var(--muted); font-style: italic; }
`),
    chunk(3, `ul { list-style: none; padding: 0; }
li { padding: 10px 0; border-bottom: 1px solid #e3ddcf; }
`, 8),
    chunk(8, `ul { list-style: none; padding: 0; }
li { display: flex; justify-content: space-between; padding: 12px 14px; margin-bottom: 8px; background: var(--card); border-radius: 8px; }
li time { color: var(--muted); font-size: 13px; }
.streak { padding: 4px 10px; border-radius: 999px; background: #ffe8cc; color: #8a3a00; font-weight: 600; font-size: 14px; }
`),
    chunk(10, `#theme { background: transparent; color: var(--ink); font-size: 20px; padding: 4px 8px; }
:root[data-theme="dark"] { --bg: #16161a; --ink: #ecebe6; --muted: #a8a59b; --card: #222228; }
`),
    chunk(11, `.burst { position: fixed; inset: 0; pointer-events: none; }
.burst i { position: absolute; top: 40%; left: 50%; width: 8px; height: 14px; border-radius: 2px; animation: fly 900ms ease-out forwards; }
@keyframes fly { to { transform: translate(var(--x), var(--y)) rotate(540deg); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .burst i { animation: none; display: none; } }
`),
  ],
  "app.js": [
    chunk(3, `const KEY = "shiplog.entries";
const list = document.getElementById("entries");
let entries = JSON.parse(localStorage.getItem(KEY) || "[]");

function render() {
  list.innerHTML = "";
  for (const e of entries) {
    const li = document.createElement("li");
    li.textContent = e.text;
`),
    chunk(8, `    const time = document.createElement("time");
    time.textContent = new Date(e.at).toLocaleDateString();
    li.append(time);
`),
    chunk(3, `    list.prepend(li);
  }
`),
    chunk(5, `  document.getElementById("empty").hidden = entries.length > 0;
`),
    chunk(7, `  document.getElementById("streak").textContent = streak() + "-day streak";
`),
    chunk(3, `}
`),
    chunk(7, `
function streak() {
  const days = new Set(entries.map((e) => new Date(e.at).toDateString()));
  let n = 0;
  for (const d = new Date(); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) n++;
  return n;
}
`),
    chunk(11, `
function burst() {
  const box = document.getElementById("burst");
  const colors = ["#d9480f", "#f59f00", "#2f9e44", "#1c7ed6"];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement("i");
    p.style.background = colors[i % colors.length];
    p.style.setProperty("--x", (Math.random() * 600 - 300).toFixed(0) + "px");
    p.style.setProperty("--y", (Math.random() * -400 + 100).toFixed(0) + "px");
    box.append(p);
  }
  setTimeout(() => (box.innerHTML = ""), 1000);
}
`),
    chunk(4, `
document.getElementById("log").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("entry");
`),
    chunk(4, `  const text = input.value;
  if (!text) return;
`, 6),
    chunk(6, `  const text = input.value.trim();
  if (!text) return;
`),
    chunk(11, `  const before = streak();
`),
    chunk(4, `  entries.push({ text, at: new Date().toISOString() });
`),
    chunk(5, `  localStorage.setItem(KEY, JSON.stringify(entries));
`),
    chunk(4, `  input.value = "";
  render();
`),
    chunk(11, `  if (before < 3 && streak() >= 3) burst();
`),
    chunk(4, `});
`),
    chunk(9, `
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "n" && document.activeElement.tagName !== "INPUT") {
    event.preventDefault();
    document.getElementById("entry").focus();
  }
});
`),
    chunk(10, `
const theme = localStorage.getItem("shiplog.theme") ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = theme;
document.getElementById("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("shiplog.theme", next);
});
`),
    chunk(3, `
render();
`),
  ],
  "package.json": [
    chunk(2, `{
  "name": "shiplog",
  "version": "0.1.0",
  "private": true,
  "scripts": { "start": "node serve.mjs" }
}
`, 12),
    chunk(12, `{
  "name": "shiplog",
  "version": "0.2.0",
  "private": true,
  "scripts": { "start": "node serve.mjs" }
}
`),
  ],
};

// 12 commits over 4 days, ending today.
const commits = [
  [0, "09:12", "Scaffold Shiplog page and base styles"],
  [0, "11:40", "Add README and a zero-dependency static server"],
  [0, "16:05", "Render logged entries from localStorage"],
  [1, "10:22", "Add a form to log what you shipped today"],
  [1, "14:48", "Persist entries and show an empty state"],
  [1, "17:30", "Ignore whitespace-only entries"],
  [2, "09:55", "Count consecutive days as a streak"],
  [2, "13:10", "Style entry rows as cards and add the streak badge"],
  [2, "18:02", "Press N to jump to the input"],
  [3, "10:15", "Add a dark mode toggle that follows the system setting"],
  [3, "14:20", "Celebrate a 3-day streak with a confetti burst"],
  [3, "16:45", "Polish copy and bump version to 0.2.0"],
];
const git = (argv, env = {}) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...argv], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "Demo Developer"]);
git(["config", "user.email", "demo@example.com"]);
const today = new Date();
commits.forEach(([dayOffset, time, subject], i) => {
  const n = i + 1;
  for (const [name, chunks] of Object.entries(files)) {
    const text = chunks
      .filter((c) => c.from <= n && n < c.to)
      .map((c) => c.text)
      .join("");
    if (text) fs.writeFileSync(path.join(repo, name), text);
  }
  const date = new Date(today);
  date.setDate(today.getDate() - (3 - dayOffset));
  const [h, m] = time.split(":").map(Number);
  date.setHours(h, m, 0, 0);
  // Never date a commit in the future (late-night runs).
  const at = new Date(Math.min(date.getTime(), Date.now() - (12 - n) * 60000));
  const offset = -at.getTimezoneOffset();
  const tz = `${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  const when = `${Math.floor(at.getTime() / 1000)} ${tz}`;
  git(["add", "-A"]);
  git(["commit", "-q", "-m", subject], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
});
console.log(`Demo project created: ${repo}
12 commits across 4 days on branch main.

Serve the app (for image capture and video recording):
  node ${path.join(repo, "serve.mjs")}
  → http://127.0.0.1:${port}

Track it in Build in Public: Add projects → Add a single repository → ${repo}
It's a throwaway repo; delete ${parent} when you're done.`);
