import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export const dataHome = () =>
  process.env.BIP_HOME ||
  path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"),
    "build-in-public",
  );
export const configPath = () =>
  process.env.BIP_HOME
    ? path.join(process.env.BIP_HOME, "config.json")
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "build-in-public/config.json",
      );
export function within(target: string, root: string) {
  return target === root || target.startsWith(root + path.sep);
}
export async function resolveSafe(input: string, roots: string[]) {
  if (input.split(/[\\/]/).includes(".."))
    throw Error("Path traversal rejected");
  const expanded =
    input === "~"
      ? os.homedir()
      : input.startsWith("~/")
        ? path.join(os.homedir(), input.slice(2))
        : input;
  if (!path.isAbsolute(expanded)) throw Error("Use an absolute path");
  const actual = await fs.realpath(expanded);
  for (const root of roots) {
    const allowed = path.resolve(root);
    if (within(actual, allowed)) return actual;
  }
  throw Error("Path is outside allowed roots");
}
export async function directorySuggestions(
  prefix: string,
  home = os.homedir(),
) {
  const expanded =
    (prefix === "~" ? "~/" : prefix).replace(/^~(?=\/|$)/, home) || home + "/";
  const trailing = expanded.endsWith("/");
  const parent = trailing ? expanded : path.dirname(expanded);
  const typed = trailing ? "" : path.basename(expanded);
  const safe = await resolveSafe(parent, [home]);
  const entries = await fs.readdir(safe, { withFileTypes: true });
  const result: string[] = [];
  for (const e of entries) {
    if (
      !e.name.startsWith(typed) ||
      (e.name.startsWith(".") && !typed.startsWith("."))
    )
      continue;
    const full = path.join(safe, e.name);
    try {
      const real = await resolveSafe(full, [home]);
      if ((await fs.stat(real)).isDirectory()) result.push(full);
    } catch {}
  }
  return result.sort().slice(0, 50);
}
export async function folderSize(root: string): Promise<number> {
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => []);
  let bytes = 0;
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) bytes += await folderSize(p);
    else if (e.isFile()) bytes += (await fs.stat(p)).size;
  }
  return bytes;
}
