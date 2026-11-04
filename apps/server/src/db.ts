import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function openDatabase(home: string) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "app.db");
  const existed = fs.existsSync(file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const version = db.pragma("user_version", { simple: true }) as number;
  const pending = fs
    .readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f) && Number(f.split("-")[0]) > version)
    .sort();
  if (pending.length && existed) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
  }
  for (const migration of pending) {
    const next = Number(migration.split("-")[0]);
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(dir, migration), "utf8"));
      db.pragma(`user_version = ${next}`);
    })();
  }
  return db;
}
