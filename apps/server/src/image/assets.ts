import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "playwright";
import { Asset, type AssetData } from "@bip/shared";
import type { Projects } from "../projects.js";
import { atomicJsonWrite } from "../bip/store.js";
export const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export async function safeFile(base: string, relative: string) {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === ".." || p === "")
  )
    throw Error("Invalid media path");
  let current = base;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat?.isSymbolicLink()) throw Error("Media symlinks are forbidden");
  }
  return current;
}
export function imageMime(b: Buffer): AssetData["mime"] {
  if (b.length > 20 * 1024 * 1024) throw Error("Images must be at most 20 MB");
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw Error("Upload a PNG, JPEG or WebP image");
}
export const thumbDir = () =>
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "build-in-public/thumbs",
  );
export class Assets {
  private chains = new Map<string, Promise<unknown>>();
  constructor(readonly projects: Projects) {}
  async root(id: string) {
    const s = await this.projects.store(id);
    await safeFile(s.repo, ".bip/assets");
    return s;
  }
  async list(id: string): Promise<AssetData[]> {
    const s = await this.root(id);
    const file = await safeFile(s.root, "assets/index.json");
    const data = JSON.parse(
      await fs.readFile(file, "utf8").catch((e) => {
        if (e.code === "ENOENT") return "{}";
        throw e;
      }),
    );
    return Object.values(data)
      .map((v) => Asset.parse(v))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async file(id: string, sha: string) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw Error("Invalid asset hash");
    const s = await this.root(id);
    return safeFile(s.root, "assets/" + sha);
  }
  async get(id: string, sha: string) {
    const item = (await this.list(id)).find((a) => a.sha === sha);
    if (!item) throw Error("Asset not found");
    return { item, bytes: await fs.readFile(await this.file(id, sha)) };
  }
  async put(
    id: string,
    bytes: Buffer,
    kind: AssetData["kind"],
    provenance: AssetData["provenance"],
    media?: {
      mime: AssetData["mime"];
      width: number;
      height: number;
      durationMs?: number;
      hasAudio?: boolean;
      quality?: AssetData["quality"];
    },
  ) {
    const mime = media?.mime || imageMime(bytes),
      sha = hash(bytes);
    // Decode using Chromium too: a matching signature alone is not a valid image.
    const b = media
      ? undefined
      : await chromium.launch({ chromiumSandbox: false });
    let dimensions: { width: number; height: number };
    try {
      if (media) dimensions = media;
      else {
        const page = await b!.newPage();
        dimensions = await page.evaluate(
          async ({ base64, mime }) => {
            const img = new Image();
            img.src = `data:${mime};base64,${base64}`;
            await img.decode();
            if (img.naturalWidth * img.naturalHeight > 100_000_000)
              throw Error("Image dimensions are too large");
            return { width: img.naturalWidth, height: img.naturalHeight };
          },
          { base64: bytes.toString("base64"), mime },
        );
      }
    } finally {
      await b?.close();
    }
    const task = (this.chains.get(id) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const s = await this.root(id);
        if (s.readOnly) throw Error("Project is read only");
        const existing = await this.list(id);
        const duplicate = existing.find(
          (a) =>
            a.sha === sha &&
            a.kind === kind &&
            JSON.stringify(a.provenance) === JSON.stringify(provenance),
        );
        if (duplicate) return duplicate;
        const temp = path.join(os.tmpdir(), "bip-asset-" + randomUUID());
        await fs.writeFile(temp, bytes);
        try {
          await s.putAsset(temp);
        } finally {
          await fs.rm(temp, { force: true });
        }
        const item = Asset.parse({
          sha,
          kind,
          mime,
          ...dimensions,
          createdAt: new Date().toISOString(),
          provenance,
        });
        await atomicJsonWrite(
          await safeFile(s.root, "assets/index.json"),
          Object.fromEntries(
            [...existing, item].map((a) => [
              a.sha +
                "-" +
                hash(Buffer.from(JSON.stringify([a.kind, a.provenance]))),
              a,
            ]),
          ),
        );
        return item;
      });
    this.chains.set(id, task);
    return task;
  }
  async thumbnail(id: string, sha: string) {
    const { item, bytes } = await this.get(id, sha);
    const dir = thumbDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, sha + ".png");
    try {
      return await fs.readFile(file);
    } catch {}
    const b = await chromium.launch({ chromiumSandbox: false });
    try {
      const page = await b.newPage({
        viewport: { width: 320, height: 200 },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        "<style>body{margin:0;background:#15171c;display:grid;place-items:center;height:100vh}img{max-width:100%;max-height:100%}</style><img>",
      );
      await page.locator("img").evaluate(
        async (e, arg) => {
          (e as HTMLImageElement).src = arg;
          await (e as HTMLImageElement).decode();
        },
        `data:${item.mime};base64,${bytes.toString("base64")}`,
      );
      const thumb = await page.screenshot();
      await fs.writeFile(file, thumb);
      return thumb;
    } finally {
      await b.close();
    }
  }
}
