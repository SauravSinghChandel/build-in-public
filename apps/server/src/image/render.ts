// Port of spikes/image/{lib,render,check-fidelity}.mjs. Same 3% calibrated pixel guard.
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { CompositionData } from "@bip/shared";
import { hash, safeFile } from "./assets.js";
type Mount = {
  dir: string;
  config: CompositionData;
  sources: Map<string, { file: string; mime: string }>;
};
const loader = (c: CompositionData, prefix: string) =>
  `<script>(async()=>{const c=${JSON.stringify(c).replace(/</g, "\\u003c")};const root=document.documentElement;root.style.setProperty('--accent',c.slots.accent);root.style.setProperty('--padding',c.slots.padding+'px');root.style.setProperty('--shadow',c.slots.shadow/100);document.body.dataset.background=c.slots.background;document.body.dataset.frame=c.slots.frame;for(const e of document.querySelectorAll('[data-slot]'))e.textContent=c.slots[e.dataset.slot]||'';for(const e of document.querySelectorAll('[data-annotation-index]')){const n=Number(e.dataset.annotationIndex);e.textContent=c.slots.annotations[n]? (n+1)+'. '+c.slots.annotations[n]:'';e.hidden=!e.textContent;}for(const e of document.querySelectorAll('[data-source-index]')){const sha=c.sources[Number(e.dataset.sourceIndex)]||c.sources[0];e.dataset.bipSource=sha;e.crossOrigin='anonymous';e.src='${prefix}/assets/'+sha;}await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));if(c.slots.background==='dominant'){const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(document.images[0],0,0,1,1);const rgb=ctx.getImageData(0,0,1,1).data;root.style.setProperty('--dominant','rgb('+[...rgb].slice(0,3).map(v=>Math.round(v*.22)).join(',')+')');}for(const frame of document.querySelectorAll('[data-bip-frame]')){const img=frame.querySelector('img');const stage=frame.parentElement;const count=stage.querySelectorAll('[data-bip-frame]').length;const column=getComputedStyle(stage).flexDirection==='column';const availableW=column?stage.clientWidth:(stage.clientWidth-(count-1)*24)/count;const availableH=(column?(stage.clientHeight-(count-1)*24)/count:stage.clientHeight)-44;frame.style.width=Math.max(8,Math.floor(Math.min(availableW,availableH*img.naturalWidth/img.naturalHeight)/8)*8)+'px';}window.bipReady=true;})();</script>`;
export class RenderOrigin {
  private server?: Server;
  private starting?: Promise<string>;
  private mounts = new Map<string, Mount>();
  origin = "";
  async start() {
    return (this.starting ??= new Promise<string>((resolve, reject) => {
      const server = (this.server = createServer(async (req, res) => {
        try {
          if (req.headers.host !== new URL(this.origin).host)
            throw Error("Bad host");
          const parts = new URL(req.url!, "http://localhost").pathname
            .split("/")
            .filter(Boolean);
          const key = parts.shift()!,
            mount = this.mounts.get(key);
          if (!mount) throw Error("Unknown composition");
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'",
          );
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Referrer-Policy", "no-referrer");
          if (parts[0] === "assets") {
            const asset = mount.sources.get(parts[1]);
            if (!asset) throw Error("Unknown source");
            res.setHeader("Content-Type", asset.mime);
            res.end(await fs.readFile(asset.file));
            return;
          }
          const relative = parts.join("/") || "index.html";
          if (
            !/^[a-zA-Z0-9_./-]+\.(?:html|css|json|svg|woff2)$/.test(relative) ||
            relative.split("/").some((p) => p.startsWith("."))
          )
            throw Error("Invalid file");
          const file = await safeFile(mount.dir, relative);
          const bytes = await fs.readFile(file);
          const ext = path.extname(file);
          res.setHeader(
            "Content-Type",
            (
              {
                ".html": "text/html",
                ".css": "text/css",
                ".json": "application/json",
                ".svg": "image/svg+xml",
                ".woff2": "font/woff2",
              } as Record<string, string>
            )[ext],
          );
          res.end(
            ext === ".html"
              ? bytes
                  .toString()
                  .replace(
                    "</body>",
                    loader(mount.config, "/" + key) + "</body>",
                  )
              : bytes,
          );
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      }));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.origin = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve(this.origin);
      });
    }));
  }
  async mount(m: Mount) {
    await this.start();
    const key = randomBytes(24).toString("hex");
    this.mounts.set(key, m);
    if (this.mounts.size > 500)
      this.mounts.delete(this.mounts.keys().next().value!);
    return this.origin + "/" + key + "/index.html";
  }
  async close() {
    if (this.server)
      await new Promise<void>((r) => this.server!.close(() => r()));
    this.mounts.clear();
  }
}
export async function overflow(page: Page) {
  return page.evaluate(() =>
    [...document.body.querySelectorAll("*")]
      .filter((e) => !["SCRIPT", "STYLE"].includes(e.tagName))
      .flatMap((e) => {
        const r = e.getBoundingClientRect();
        return r.width &&
          r.height &&
          (r.x < -0.5 ||
            r.y < -0.5 ||
            r.right > innerWidth + 0.5 ||
            r.bottom > innerHeight + 0.5)
          ? [e.tagName + "." + e.className]
          : [];
      }),
  );
}
export async function renderAndCheck(
  url: string,
  config: CompositionData,
  sources: Mount["sources"],
  format: "png" | "jpeg" = "png",
) {
  const b = await chromium.launch({ chromiumSandbox: false });
  try {
    const context = await b.newContext({
      viewport: { width: config.width, height: config.height },
      deviceScaleFactor: 2,
      serviceWorkers: "block",
    });
    const origin = new URL(url).origin;
    await context.route("**/*", (r) =>
      new URL(r.request().url()).origin === origin
        ? r.continue()
        : r.abort("blockedbyclient"),
    );
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await page.waitForFunction(
      () => (window as any).bipReady === true,
      undefined,
      { timeout: 15000 },
    );
    const lint = await page.evaluate(() => {
      const errors: string[] = [],
        images: {
          sha: string;
          src: string;
          box: { x: number; y: number; width: number; height: number };
        }[] = [];
      const overlap = (a: DOMRect, b: DOMRect) =>
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top;
      for (const img of document.querySelectorAll<HTMLImageElement>(
        "[data-bip-source]",
      )) {
        const r = img.getBoundingClientRect();
        images.push({
          sha: img.dataset.bipSource!,
          src: img.src,
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        });
        for (
          let e: Element | null = img;
          e && e !== document.documentElement;
          e = e.parentElement
        ) {
          const s = getComputedStyle(e);
          for (const k of ["filter", "mixBlendMode", "backdropFilter"] as const)
            if (s[k] !== (k === "mixBlendMode" ? "normal" : "none"))
              errors.push(`${k}=${s[k]}`);
          if (Number(s.opacity) < 1) errors.push("Screenshot opacity changed");
          if (s.transform !== "none")
            errors.push("Screenshot transform unsupported");
        }
        const walk = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        while (walk.nextNode()) {
          const n = walk.currentNode,
            p = n.parentElement!;
          if (
            !n.textContent?.trim() ||
            p.closest("script,style,[data-bip-annotation]") ||
            getComputedStyle(p).visibility === "hidden" ||
            !p.getClientRects().length
          )
            continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          if ([...range.getClientRects()].some((t) => overlap(r, t)))
            errors.push(
              "Unmarked text overlaps screenshot: " +
                n.textContent.slice(0, 70),
            );
        }
      }
      if (!images.length) errors.push("Missing source image");
      return { errors, images };
    });
    const bytes = await page.screenshot({ animations: "disabled" }),
      screen = PNG.sync.read(bytes),
      diffs = [];
    const integrity: string[] = [];
    for (const sha of config.sources) {
      const src = sources.get(sha);
      if (!src || hash(await fs.readFile(src.file)) !== sha)
        integrity.push("Source bytes do not match hash: " + sha);
    }
    for (const item of lint.images) {
      if (
        !config.sources.includes(item.sha) ||
        !item.src.endsWith("/assets/" + item.sha)
      )
        integrity.push("Source URL does not match declared hash");
      const { x, y, width, height } = item.box,
        px = Math.round(x * 2),
        py = Math.round(y * 2),
        w = Math.round(width * 2),
        h = Math.round(height * 2);
      if (
        w < 1 ||
        h < 1 ||
        px < 0 ||
        py < 0 ||
        px + w > screen.width ||
        py + h > screen.height
      ) {
        lint.errors.push("Source outside canvas");
        continue;
      }
      // Use a clean browser image at the same fractional box, rather than canvas resampling.
      // This hardens the spike calibration for high-frequency UI pixels and small sources.
      const reference = await context.newPage();
      await reference.setContent(
        '<html><body style="margin:0;background:#15171c"><img></body></html>',
      );
      await reference.locator("img").evaluate(
        async (e, arg) => {
          const img = e as HTMLImageElement;
          Object.assign(img.style, {
            position: "absolute",
            left: arg.x + "px",
            top: arg.y + "px",
            width: arg.width + "px",
            height: arg.height + "px",
            display: "block",
          });
          img.src = arg.src;
          await img.decode();
        },
        { src: item.src, ...item.box },
      );
      const baseline = PNG.sync.read(
        await reference.screenshot({ animations: "disabled" }),
      );
      await reference.close();
      const expected = new PNG({ width: w, height: h }),
        actual = new PNG({ width: w, height: h });
      PNG.bitblt(baseline, expected, px, py, w, h, 0, 0);
      PNG.bitblt(screen, actual, px, py, w, h, 0, 0);
      const pct =
        (pixelmatch(actual.data, expected.data, undefined, w, h, {
          threshold: 0.1,
          includeAA: false,
        }) /
          (w * h)) *
        100;
      diffs.push({ sha: item.sha, mismatchPct: pct });
      if (pct > 3)
        lint.errors.push(
          `Screenshot pixel mismatch ${pct.toFixed(2)}% exceeds 3%`,
        );
    }
    const outside = await overflow(page);
    const errors = [
      ...integrity,
      ...(outside.length
        ? ["Elements outside canvas: " + outside.join(", ")]
        : []),
      ...(!config.allowScreenshotEdits ? lint.errors : []),
    ];
    return {
      bytes:
        format === "png"
          ? bytes
          : await page.screenshot({
              type: "jpeg",
              quality: 90,
              animations: "disabled",
            }),
      fidelity: { pass: errors.length === 0, errors, diffs },
    };
  } finally {
    await b.close();
  }
}
