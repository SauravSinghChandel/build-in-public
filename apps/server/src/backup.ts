import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolveSafe } from "./paths.js";
const exec = promisify(execFile);
export async function backup(home: string, id: string, repo: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid project id");
  await resolveSafe(path.join(repo, ".bip"), [repo]);
  const dir = path.join(home, "backups", id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `${new Date().toISOString().replace(/:/g, "-")}-${randomUUID().slice(0, 8)}.tar.gz`,
  );
  await exec(
    "tar",
    [
      "--exclude=.bip/renders",
      "--exclude=.bip/.lock",
      "-czf",
      file,
      "-C",
      repo,
      ".bip",
    ],
    { timeout: 30000 },
  );
  return { file };
}
