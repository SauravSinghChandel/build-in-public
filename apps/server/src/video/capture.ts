import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { VideoCaptureInput, type CaptureStep } from "@bip/shared";
import { z } from "zod";
import { browserPath, command } from "./process.js";
import { captureQuality, type EventLog } from "./model.js";
export async function executeStep(page: Page, s: z.infer<typeof CaptureStep>) {
  if (s.action === "pause" || s.action === "wait")
    await page.waitForTimeout(s.ms ?? 1000);
  else if (s.action === "click") await page.locator(s.selector!).click();
  else if (s.action === "type") await page.locator(s.selector!).fill(s.text!);
  else if (s.action === "hover") await page.locator(s.selector!).hover();
  else if (s.action === "press") await page.keyboard.press(String(s.value));
  else if (s.action === "scroll") {
    if (s.selector)
      await page
        .locator(s.selector)
        .evaluate((e, value) => e.scrollBy(0, value), Number(s.value ?? 500));
    else await page.mouse.wheel(0, Number(s.value ?? 500));
  } else if (s.action === "scrollTo")
    await page.evaluate(async ({ selector, y, durationMs }) => {
      const el = selector ? document.querySelector(selector) : null;
      if (selector && !el) throw Error("Scroll selector not found");
      const target = el ? el.getBoundingClientRect().top + scrollY : y!,
        start = scrollY,
        base = performance.now();
      await new Promise<void>((resolve) => {
        function frame(now: number) {
          const t = Math.min(1, (now - base) / durationMs!);
          window.scrollTo(0, start + (target - start) * (t * t * (3 - 2 * t)));
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });
    }, s);
}
export async function captureDemo(
  input: z.infer<typeof VideoCaptureInput>,
  dir: string,
  signal: AbortSignal,
) {
  const [width, height] = input.viewport.split("x").map(Number);
  await fs.mkdir(dir, { recursive: true });
  const configDir = path.join(dir, "browser-config");
  await fs.mkdir(configDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: browserPath(),
    chromiumSandbox: false,
    env: { ...process.env, XDG_CONFIG_HOME: configDir },
  });
  const abort = () => void browser.close();
  signal.addEventListener("abort", abort, { once: true });
  const log: EventLog = {
    viewport: { width, height },
    duration: 0,
    events: [],
    actions: [],
    frames: [],
  };
  try {
    const context = await browser.newContext({
        viewport: { width, height },
        serviceWorkers: "block",
        acceptDownloads: false,
      }),
      page = await context.newPage();
    page.setDefaultTimeout(10000);
    let base = 0;
    await page.exposeFunction("__bipEvent", (e: any) => {
      if (base)
        log.events.push({ ...e, t: (e.epoch - base) / 1000, epoch: undefined });
    });
    await page.addInitScript(() => {
      const log = (type: string, e?: MouseEvent) =>
        void (window as any).__bipEvent({
          type,
          epoch: performance.timeOrigin + performance.now(),
          x: e?.clientX || 0,
          y: e?.clientY || 0,
          scrollY: window.scrollY,
          url: location.href,
        });
      for (const type of ["pointermove", "click", "scroll"])
        addEventListener(type, (e) => log(type, e as MouseEvent), {
          passive: true,
        });
      addEventListener("DOMContentLoaded", () => {
        log("navigation");
        const style = document.createElement("style");
        style.textContent =
          "*{cursor:none!important}.cur,.cursor,.custom-cursor,.cursor-dot,.cursor-ring,.cursor-overlay,#cursor,#custom-cursor,[data-cursor-overlay]{visibility:hidden!important}";
        document.head.append(style);
      });
    });
    await page.goto(input.url, { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const cdp = await context.newCDPSession(page),
      pending: Promise<unknown>[] = [];
    cdp.on("Page.screencastFrame", (e) => {
      const i = log.frames.length;
      log.frames.push({
        t: (e.metadata.timestamp ?? Date.now() / 1000) * 1000 - base,
      });
      pending.push(
        fs.writeFile(
          path.join(dir, `${String(i).padStart(6, "0")}.jpg`),
          Buffer.from(e.data, "base64"),
        ),
      );
      void cdp
        .send("Page.screencastFrameAck", { sessionId: e.sessionId })
        .catch(() => {});
    });
    base = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    log.events.push({ type: "navigation", t: 0, x: 0, y: 0, url: input.url });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 90,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
    const now = () => (Date.now() - base) / 1000;
    for (const s of input.steps) {
      signal.throwIfAborted();
      const action = { label: s.action, t: now(), endT: 0 };
      log.actions.push(action);
      await executeStep(page, s);
      action.endT = now();
    }
    await page.waitForTimeout(100);
    log.duration = now();
    await cdp.send("Page.stopScreencast");
    await Promise.all(pending);
    if (!log.frames.length) throw Error("No screencast frames delivered");
    // CDP timestamps share the epoch clock with the injected event log; pad the initial frame to t=0.
    let concat = "";
    for (let i = 0; i < log.frames.length; i++) {
      const next = log.frames[i + 1]?.t ?? log.duration * 1000;
      const at = i === 0 ? 0 : log.frames[i].t;
      concat += `file '${String(i).padStart(6, "0")}.jpg'\nduration ${Math.max(0.001, (next - at) / 1000)}\n`;
    }
    concat += `file '${String(log.frames.length - 1).padStart(6, "0")}.jpg'\n`;
    await fs.writeFile(path.join(dir, "frames.txt"), concat);
    const file = path.join(dir, "recording.mp4");
    await command(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        path.join(dir, "frames.txt"),
        "-vf",
        "fps=30",
        "-t",
        String(log.duration),
        "-c:v",
        "libx264",
        "-crf",
        "19",
        "-pix_fmt",
        "yuv420p",
        file,
      ],
      { signal },
    );
    return {
      file,
      log,
      quality: captureQuality(
        log.frames.map((f) => f.t),
        log.duration * 1000,
      ),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close();
  }
}
