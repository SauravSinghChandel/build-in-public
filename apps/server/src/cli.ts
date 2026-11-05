#!/usr/bin/env node
import { appPort } from "./config.js";
import { start } from "./index.js";
import { doctor } from "./doctor.js";
import { dataHome } from "./paths.js";
import { openDatabase } from "./db.js";
import { backup } from "./backup.js";
import { createApp } from "./app.js";
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
  } else
    throw Error(
      "Usage: bip start | doctor | publish-due | backup [--project <id> | --all]",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
