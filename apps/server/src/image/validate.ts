import fs from "node:fs/promises";
import path from "node:path";
import { Composition } from "@bip/shared";
export async function validateComposition(dir: string) {
  const errors: string[] = [];
  for(const file of ["composition.json","index.html","styles.css"]) {
    try { if(!(await fs.lstat(path.join(dir,file))).isFile()) errors.push("Required composition file missing: "+file); }
    catch { errors.push("Required composition file missing: "+file); }
  }
  async function walk(base: string) {
    for (const e of await fs.readdir(base, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const file = path.join(base, e.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        errors.push("Symlinks are forbidden");
        continue;
      }
      if (e.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!/\.(html|css|json|svg|woff2)$/.test(e.name))
        errors.push("Disallowed extension: " + e.name);
      if (stat.size > 1024 * 1024) errors.push("File exceeds 1 MB: " + e.name);
      if (/\.(html|css|svg)$/.test(e.name)) {
        const text = await fs.readFile(file, "utf8");
        if (
          /(?:https?:|file:|ftp:|\/\/)/i.test(
            text.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ""),
          )
        )
          errors.push("External URLs are forbidden: " + e.name);
        if (/<(iframe|object|embed|base|meta\b[^>]*http-equiv)\b/i.test(text))
          errors.push("Embedded documents are forbidden");
        if (/\bon\w+\s*=/i.test(text))
          errors.push("Inline event handlers are forbidden");
        // Only the exact BIP inline slot loader is permitted, injected by the render origin.
        if (/<script\b/i.test(text))
          errors.push("Scripts are forbidden; BIP supplies the slot loader");
        if (/(?:@import|javascript\s*:)/i.test(text))
          errors.push("Active or imported resources are forbidden");
      }
    }
  }
  await walk(dir);
  try {
    Composition.parse(
      JSON.parse(await fs.readFile(path.join(dir, "composition.json"), "utf8")),
    );
  } catch (e) {
    errors.push("Invalid composition.json: " + String(e));
  }
  return errors;
}
