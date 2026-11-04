#!/usr/bin/env node
import { appPort } from "./config.js";
import { start } from "./index.js";
import { doctor } from "./doctor.js";
import { dataHome } from "./paths.js";
import { openDatabase } from "./db.js";
import { backup } from "./backup.js";
const args = process.argv.slice(2);
const command = args[0] || "start";
try {
  if (command === "start") await start();
  else if (command === "doctor") {
    const db = openDatabase(dataHome());
    const repos = (
      db.prepare("SELECT path FROM projects").all() as { path: string }[]
    ).map((r) => r.path);
    db.close();
    const report = await doctor(dataHome(), appPort(), false, repos);
    for (const c of report.checks)
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` — ${c.hint}`}`);
    if (report.checks.some((c) => !c.ok && c.hard)) process.exitCode = 1;
  } else if (command === "backup") {
    const db = openDatabase(dataHome());
    try {
      const project = args.indexOf("--project");
      if (!args.includes("--all") && project === -1)
        throw Error("Use backup --project <id> or backup --all");
      const rows = (
        project >= 0
          ? db
              .prepare("SELECT id,path FROM projects WHERE id=?")
              .all(args[project + 1])
          : db.prepare("SELECT id,path FROM projects").all()
      ) as { id: string; path: string }[];
      if (project >= 0 && !rows.length) throw Error("Project not found");
      for (const r of rows)
        console.log((await backup(dataHome(), r.id, r.path)).file);
    } finally {
      db.close();
    }
  } else
    throw Error("Usage: bip start | doctor | backup [--project <id> | --all]");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
