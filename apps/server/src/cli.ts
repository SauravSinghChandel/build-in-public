#!/usr/bin/env node
import path from "node:path";
import { appPort } from "./config.js";
import { start } from "./index.js";
import { doctor, versions } from "./doctor.js";
import { dataHome } from "./paths.js";
import { openDatabase } from "./db.js";
import { backup } from "./backup.js";
import { createApp } from "./app.js";
import { setup } from "./setup.js";
export const HELP = `Usage: bip <command> [options]

Commands:
  start                 Start the local app (default)
  setup                 Check requirements, write the default config, print the start command
  doctor                Check the environment and show tool versions
  publish-due           Post scheduled items that are due (when the app isn't running)
  backup                Back up project data: --project <id> | --all

Options:
  --port <n>            Port to listen on (default 4310, or BIP_PORT / config port)
  --no-open             Don't open the browser on start
  --data-dir <path>     App data folder, including config.json (default
                        ~/.local/share/build-in-public; same as BIP_HOME)
  --ci                  doctor: skip agent sign-in checks
  --yes                 setup: install Playwright Chromium without asking
  -h, --help            Show this help
  -v, --version         Show the version

Environment: BIP_HOME, BIP_PORT, BIP_NO_OPEN, BIP_CLAUDE_BIN, BIP_CODEX_BIN.`;
const args = process.argv.slice(2);
function flagValue(name: string) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("-"))
    throw Error(`${name} needs a value. Run bip --help for usage.`);
  args.splice(i, 2);
  return value;
}
function flag(...names: string[]) {
  const i = args.findIndex((a) => names.includes(a));
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}
try {
  if (flag("-h", "--help", "help")) {
    console.log(HELP);
    process.exit(0);
  }
  if (flag("-v", "--version")) {
    console.log((await versions([])).bip);
    process.exit(0);
  }
  const port = flagValue("--port");
  if (port !== undefined) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw Error(`--port must be a number from 1 to 65535, not "${port}".`);
    process.env.BIP_PORT = port;
  }
  const dataDir = flagValue("--data-dir");
  if (dataDir !== undefined) process.env.BIP_HOME = path.resolve(dataDir);
  if (flag("--no-open")) process.env.BIP_NO_OPEN = "1";
  const ci = flag("--ci"),
    yes = flag("--yes", "-y");
  const command = args[0] || "start";
  if (command === "start") await start();
  else if (command === "setup") process.exitCode = await setup({ yes });
  else if (command === "doctor") {
    const db = openDatabase(dataHome());
    const repos = (
      db.prepare("SELECT path FROM projects").all() as { path: string }[]
    ).map((r) => r.path);
    db.close();
    const report = await doctor(dataHome(), appPort(), false, repos, { ci });
    for (const c of report.checks)
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` — ${c.hint}`}`);
    if (ci) console.log("- Agent sign-in checks skipped (--ci)");
    const v = report.versions;
    if (v)
      console.log(
        `\nVersions: BIP ${v.bip} · HyperFrames ${v.hyperframes ?? "missing"} · Playwright ${v.playwright ?? "missing"} · claude ${v.claude ?? (ci ? "skipped" : "not installed")} · codex ${v.codex ?? (ci ? "skipped" : "not installed")}`,
      );
    if (report.checks.some((c) => !c.ok && c.hard)) process.exitCode = 1;
  } else if (command === "backup") {
    const db = openDatabase(dataHome());
    try {
      const project = args.indexOf("--project");
      if (!args.includes("--all") && project === -1)
        throw Error(
          "Choose what to back up: bip backup --project <id> or bip backup --all",
        );
      const rows = (
        project >= 0
          ? db
              .prepare("SELECT id,path FROM projects WHERE id=?")
              .all(args[project + 1])
          : db.prepare("SELECT id,path FROM projects").all()
      ) as { id: string; path: string }[];
      if (project >= 0 && !rows.length)
        throw Error(
          `No tracked project has the id "${args[project + 1]}". Check the id in the app's project URL.`,
        );
      for (const r of rows)
        console.log((await backup(dataHome(), r.id, r.path)).file);
    } finally {
      db.close();
    }
  } else if (command === "publish-due") {
    // The running app's scheduler owns due posts; never compete with it.
    const port = appPort();
    const running = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      () => true,
      () => false,
    );
    if (running) {
      console.log("Build in Public is running; its scheduler posts due items.");
    } else {
      const service = createApp({ port });
      try {
        await service.projects.rescan();
        const { enqueued, jobs } = await service.publisher.runDue();
        for (const j of jobs)
          console.log(
            `${j.status === "succeeded" ? "✓" : "✗"} ${j.payload.platform} post ${j.payload.postId}${j.error ? ` — ${j.error}` : ""}`,
          );
        console.log(`${enqueued} due post${enqueued === 1 ? "" : "s"} processed.`);
        if (jobs.some((j) => j.status !== "succeeded")) process.exitCode = 1;
      } finally {
        await service.close();
      }
    }
  } else throw Error(`Unknown command "${command}".\n\n${HELP}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
