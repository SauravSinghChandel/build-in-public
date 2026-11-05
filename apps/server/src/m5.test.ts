import { it, expect, beforeEach, afterEach, describe, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { PNG } from "pngjs";
import { ERROR_DETAILS, splitJobError, stripAnsi } from "@bip/shared";
import { createApp } from "./app.js";
import { git } from "./git.js";
import {
  friendlyNavigationError,
  friendlyStepError,
} from "./capture/errors.js";
import { elementMap, validateSteps } from "./capture/pagemap.js";
import { activityLabel } from "./agents/activity.js";
import { normalize } from "./agents/index.js";
import { briefCaptions, readmeWebsite } from "./video/copy.js";
import { buildHtml, fitTitle, textEm } from "./video/build.js";
import { renderHtml, stageFonts } from "./video/validate.js";
import { thumbDir } from "./image/assets.js";
import { isHardwareRenderer, launchCaptureBrowser } from "./video/capture.js";

const fake = path.resolve("tests/fixtures/agents/fake.mjs");
const PAGE = `<!doctype html><html><body>
<nav><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
<h1>Mode switcher</h1>
<button>Simple</button><button>Simple mode</button><button aria-label="Close dialog">×</button>
<button class="dup">Save</button><button class="dup">Save</button>
<label>Email <input name="email" type="email"></label>
<input placeholder="Search docs" type="search">
<button style="display:none">Hidden</button>
<a href="#" onclick="document.body.dataset.clicked=1">Switch to Simple mode</a>
</body></html>`;

let server: Server, origin: string;
async function serve(html: string) {
  server = createServer((_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  vi.unstubAllEnvs();
});

describe("Friendly capture errors (§0.2)", () => {
  it("strips ANSI codes and maps Playwright failures to actionable messages", () => {
    const timeout = Object.assign(
      Error(
        "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#nope')\u001b[22m\n",
      ),
      { name: "TimeoutError" },
    );
    const missing = friendlyStepError(
      1,
      { action: "click", selector: "#nope" },
      timeout,
    );
    const { message, details } = splitJobError(missing.message);
    expect(message).toBe("Step 2: couldn't find `#nope`.");
    expect(details).toContain("waiting for locator('#nope')");
    expect(details).not.toMatch(/\u001b/);
    const strict = friendlyStepError(
      0,
      { action: "click", selector: "button" },
      Error(
        "locator.click: Error: strict mode violation: locator('button') resolved to 3 elements:\n 1) <button>Simple</button>",
      ),
    );
    expect(splitJobError(strict.message).message).toBe(
      "Step 1: `button` matches 3 elements. Make it more specific.",
    );
    expect(
      splitJobError(
        friendlyStepError(
          2,
          { action: "click", selector: "[[" },
          Error(
            'locator.click: Unexpected token "" while parsing css selector "[["',
          ),
        ).message,
      ).message,
    ).toBe("Step 3: `[[` isn't a valid selector.");
    expect(
      splitJobError(
        friendlyNavigationError(
          "http://localhost:3000",
          Error(
            "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/",
          ),
        ).message,
      ).message,
    ).toBe(
      "Couldn't open http://localhost:3000: connection refused. Check that the site is running.",
    );
    expect(stripAnsi("\u001b[31mred\u001b[39m \u001b]8;;x\u0007link")).toBe(
      "red link",
    );
    expect(splitJobError("plain")).toEqual({ message: "plain", details: "" });
    expect(ERROR_DETAILS).toContain("Details");
  });
});

describe("Page-aware step generation (§0.1)", () => {
  let browser: Browser;
  beforeEach(async () => {
    browser = await chromium.launch({ chromiumSandbox: false });
  });
  afterEach(async () => {
    await browser.close();
  });
  it("extracts a compact, unique, deduplicated element map", async () => {
    await serve(PAGE);
    const page = await browser.newPage();
    await page.goto(origin);
    const map = await elementMap(page);
    const selectors = map.map((e) => e.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(selectors).toEqual(
      expect.arrayContaining([
        'role=button[name="Simple"]',
        'role=button[name="Simple mode"]',
        'role=button[name="Close dialog"]',
        'role=link[name="Docs"]',
        'role=link[name="Switch to Simple mode"]',
        'role=heading[name="Mode switcher"]',
        'role=textbox[name="Email"]',
        'role=searchbox[name="Search docs"]',
      ]),
    );
    // Duplicate "Save" buttons have no unique selector and hidden elements are skipped.
    expect(selectors.some((s) => s.includes("Save"))).toBe(false);
    expect(selectors.some((s) => s.includes("Hidden"))).toBe(false);
    for (const s of selectors) expect(await page.locator(s).count()).toBe(1);
    expect(map.find((e) => e.selector.includes("Docs"))).toMatchObject({
      role: "link",
      name: "Docs",
      href: "/docs",
    });
    expect((await elementMap(page, 3)).length).toBe(3);
  });
  it("dry-runs steps against the live page and marks missing, ambiguous and invalid ones", async () => {
    await serve(PAGE);
    const page = await browser.newPage();
    await page.goto(origin);
    const checks = await validateSteps(page, [
      { action: "click", selector: 'role=button[name="Simple"]' },
      { action: "click", selector: "#nope" },
      { action: "click", selector: "button.dup" },
      { action: "click", selector: "[[" },
      { action: "pause" },
    ]);
    expect(checks.map((c) => c.status)).toEqual([
      "ok",
      "missing",
      "ambiguous",
      "invalid",
      "none",
    ]);
    expect(checks[2]).toMatchObject({ count: 2 });
  });
});

describe("Capture browser GPU selection (§0.8)", () => {
  it("only keeps GPU flags when WebGL runs on real hardware", async () => {
    expect(
      isHardwareRenderer(
        "ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir ACO), OpenGL ES 3.2)",
      ),
    ).toBe(true);
    expect(
      isHardwareRenderer(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)",
      ),
    ).toBe(false);
    expect(isHardwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(false);
    expect(isHardwareRenderer("")).toBe(false);
    const { browser, renderer } = await launchCaptureBrowser({
      chromiumSandbox: false,
    });
    try {
      // Either a hardware renderer was found, or the fallback (default Chromium) is in use.
      expect(typeof renderer).toBe("string");
      expect(browser.isConnected()).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
describe("Agent activity (§0.5)", () => {
  it("turns Claude and Codex tool events into short activity lines", () => {
    const claude = normalize(
      "claude",
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              id: "1",
              input: { file_path: "/w/comp/styles.css" },
            },
            {
              type: "tool_use",
              name: "Edit",
              id: "2",
              input: { file_path: "/w/comp/index.html" },
            },
            {
              type: "tool_use",
              name: "Bash",
              id: "3",
              input: { command: "sed -n 1,20p motion.js" },
            },
            {
              type: "tool_use",
              name: "Grep",
              id: "4",
              input: { pattern: "caption" },
            },
          ],
        },
      },
      {},
    );
    expect(claude.map(activityLabel)).toEqual([
      "Reading styles.css…",
      "Editing index.html…",
      "Reading motion.js…",
      "Searching for caption…",
    ]);
    const started = normalize(
      "codex",
      {
        type: "item.started",
        item: {
          id: "c",
          type: "command_execution",
          command: "/bin/bash -lc 'cat styles.css'",
        },
      },
      {},
    );
    const changed = normalize(
      "codex",
      {
        type: "item.completed",
        item: {
          id: "f",
          type: "file_change",
          changes: [{ path: "/w/index.html" }, { path: "/w/composition.json" }],
        },
      },
      {},
    );
    expect(activityLabel(started[0])).toBe("Reading styles.css…");
    expect(activityLabel(changed[0])).toBe(
      "Editing index.html, composition.json…",
    );
    expect(activityLabel({ type: "text", text: "hi" })).toBeUndefined();
    expect(
      activityLabel({ type: "tool", id: "1", output: "x" }),
    ).toBeUndefined();
  });
});

describe("Video copy, fonts and fit (§0.6, §0.7)", () => {
  it("finds the project's website in a README and builds captions from a brief", () => {
    expect(
      readmeWebsite(
        "# App\n[![CI](https://github.com/me/app/badge.svg)](https://github.com/me/app)\nLive at https://app.example.dev/ — try it.\n",
      ),
    ).toBe("app.example.dev");
    expect(
      readmeWebsite("# App\nSee https://github.com/me/app\n"),
    ).toBeUndefined();
    expect(readmeWebsite("Website: https://www.jane.design/work.")).toBe(
      "jane.design/work",
    );
    expect(briefCaptions("")).toEqual([]);
    expect(
      briefCaptions(
        "Capture is now page-aware. Agents see the real page. Third.",
      ),
    ).toEqual(["Capture is now page-aware.", "Agents see the real page."]);
  });
  it("fits long title text within 90% of the frame width", () => {
    expect(fitTitle("Short title")).toBe(7);
    const url = "my-extremely-long-portfolio-domain-name.example.dev";
    const f = fitTitle(url);
    expect(f).toBeLessThan(7);
    expect(textEm(url) * f).toBeLessThanOrEqual(90);
    const long =
      "A much longer outro line that would otherwise run off the edge of the frame on every size we export";
    expect(fitTitle(long)).toBeLessThan(7);
  });
  it("bundles IBM Plex and keeps long title/outro cards inside 90% of the frame", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m5-fit-"));
    const browser = await chromium.launch({ chromiumSandbox: false });
    try {
      const headline = "my-extremely-long-portfolio-domain-name.example.dev";
      await buildHtml(
        dir,
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000000",
          type: "video",
          title: "t",
          fps: 30,
          durationMs: 2000,
          style: "clean",
          sources: ["a".repeat(64)],
          scenes: [
            {
              id: "intro",
              kind: "title",
              startMs: 0,
              endMs: 1000,
              notes: headline,
            },
            {
              id: "outro",
              kind: "outro",
              startMs: 1000,
              endMs: 2000,
              notes: "portfolio\njane.design",
            },
          ],
          captions: [],
        },
        new Map(),
      );
      await fs.copyFile(
        path.resolve("packages/templates/video/clean/styles.css"),
        path.join(dir, "styles.css"),
      );
      await stageFonts(dir);
      const html = renderHtml(
        await fs.readFile(path.join(dir, "index.html"), "utf8"),
      );
      expect(html).toContain("@font-face{font-family:'IBM Plex Sans'");
      expect(html).not.toMatch(
        /Built with intention|Build · Ship · Share|Built\. Tested/,
      );
      await fs.writeFile(path.join(dir, "index.html"), html);
      await serve("");
      server.removeAllListeners("request");
      server.on("request", async (req, res) => {
        const file = path.join(
          dir,
          decodeURIComponent(new URL(req.url!, origin).pathname),
        );
        try {
          const body = await fs.readFile(
            file.endsWith("/") ? file + "index.html" : file,
          );
          res.setHeader(
            "content-type",
            file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".woff2")
                ? "font/woff2"
                : "text/html",
          );
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
        [960, 540],
      ]) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(origin);
        await page.evaluate(() => document.fonts.ready);
        const result = await page.evaluate(() => {
          const h = document.querySelector("#scene-0 h1")!;
          const range = document.createRange();
          range.selectNodeContents(h);
          return {
            text: range.getBoundingClientRect().width,
            plex: document.fonts.check('600 40px "IBM Plex Sans"'),
            family: getComputedStyle(h).fontFamily,
            loaded: [...document.fonts]
              .filter((f) => f.status === "loaded")
              .map((f) => f.family),
            sub: document.querySelector("#scene-1 p")?.textContent,
          };
        });
        expect(result.text).toBeLessThanOrEqual(width * 0.9);
        expect(result.family).toContain("IBM Plex Sans");
        expect(result.loaded).toContain("IBM Plex Sans");
        expect(result.plex).toBe(true);
        expect(result.sub).toBe("jane.design");
        await page.close();
      }
    } finally {
      await browser.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Studio integration (§0.1, §0.4, §0.6)", () => {
  let root: string, repo: string, s: ReturnType<typeof createApp>, id: string;
  const png = (w = 640, h = 400) => {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < p.data.length; i += 4) {
      p.data[i] = (i / 4) % 255;
      p.data[i + 1] = 80;
      p.data[i + 2] = 160;
      p.data[i + 3] = 255;
    }
    return PNG.sync.write(p);
  };
  async function done(jobId: string) {
    await vi.waitFor(
      () =>
        expect(["succeeded", "failed"]).toContain(
          s.content.jobs.get(jobId).status,
        ),
      { timeout: 60000, interval: 100 },
    );
    return s.content.jobs.get(jobId);
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m5-studio-"));
    repo = path.join(root, "external/portfolio");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await fs.writeFile(
      path.join(repo, "README.md"),
      "# Portfolio\nLive: https://jane.design\n",
    );
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@localhost",
      "commit",
      "-m",
      "Add the portfolio site",
    ]);
    await fs.mkdir(path.join(root, "home"));
    s = createApp({
      home: path.join(root, "data"),
      fsHome: path.join(root, "home"),
    });
    await s.projects.scan(path.dirname(repo), 2);
    id = (await s.projects.track([repo]))[0].id;
    vi.stubEnv("BIP_CLAUDE_BIN", fake);
    vi.stubEnv("BIP_CODEX_BIN", fake);
  });
  afterEach(async () => {
    await s.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  it("loads the page, passes the element map to the agent and validates generated steps", async () => {
    await serve(PAGE);
    const job = s.images.task("image.steps", id, {
      provider: "claude",
      description: "Click the Simple button FAKE_USE_MAP",
      url: origin,
      viewport: "1280x800",
    });
    const result = (await done(job.id)).result as {
      steps: { selector: string }[];
      checks: { status: string }[];
      elements: number;
    };
    expect(result.elements).toBeGreaterThan(5);
    expect(result.steps[0].selector).toMatch(/^role=button\[name=/);
    expect(result.checks.map((c) => c.status)).toEqual([
      "ok",
      "missing",
      "ambiguous",
    ]);
    const log = await fs.readFile(
      (
        s.content.db
          .prepare("SELECT log_path FROM agent_runs WHERE job_id=?")
          .get(job.id) as { log_path: string }
      ).log_path,
      "utf8",
    );
    expect(log.length).toBeGreaterThan(0);
    // Without a URL the old description-only path still works.
    const plain = await done(
      s.images.task("image.steps", id, {
        provider: "codex",
        description: "Wait",
      }).id,
    );
    expect(plain.result.steps).toEqual([{ action: "wait", ms: 50 }]);
  });
  it("reports capture step failures as friendly errors with raw details", async () => {
    await serve(PAGE);
    const job = s.images.task("image.capture", id, {
      url: origin,
      steps: [{ action: "click", selector: "#nope" }],
    });
    const failed = await done(job.id);
    expect(failed.status).toBe("failed");
    const { message, details } = splitJobError(failed.error);
    expect(message).toBe("Step 1: couldn't find `#nope`.");
    expect(details).toContain("Timeout");
    expect(failed.error).not.toMatch(/\u001b/);
  }, 30000);
  it("renders revision 1's thumbnail on create", async () => {
    const a = await s.images.assets.put(id, png(), "upload", {
      type: "upload",
      filename: "s.png",
    });
    const v = await s.images.create(id, { preset: "launch", sources: [a.sha] });
    await s.images.drain();
    const file = path.join(
      thumbDir(),
      `composition-${v.composition.id}-${v.commit}.png`,
    );
    const img = PNG.sync.read(await fs.readFile(file));
    const colours = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4 * 97)
      colours.add(img.data.readUInt32BE(i));
    expect(colours.size).toBeGreaterThan(20);
  });
  it("uses no placeholder copy: captions only from a brief, outro from the project and README", async () => {
    const a = await s.images.assets.put(id, png(), "upload", {
      type: "upload",
      filename: "s.png",
    });
    const plain = await s.videos.create(id, {
      sources: [a.sha],
      style: "clean",
    });
    expect(plain.composition.captions).toEqual([]);
    const notes = plain.composition.scenes.map((sc) => sc.notes);
    expect(notes[0]).toBe("portfolio");
    expect(notes.at(-1)).toBe("portfolio\njane.design");
    const html = await fs.readFile(
      path.join(await s.videos.dir(id, plain.composition.id), "index.html"),
      "utf8",
    );
    for (const filler of [
      "A closer look",
      "Small details",
      "Built. Tested",
      "Built with intention",
      "Build · Ship",
      "A detail worth sharing",
      "The detail that matters",
      "The useful detail",
      "The implementation",
    ])
      expect(html).not.toContain(filler);
    const technical = await s.videos.update(id, plain.composition.id, {
      style: "technical",
    });
    const terminal = technical.composition.scenes.find(
      (sc) => sc.id === "terminal",
    )!;
    expect(terminal.notes).toContain("Add the portfolio site");
    const briefed = await s.videos.create(id, {
      sources: [a.sha],
      style: "clean",
      brief: "Page-aware capture. The agent sees the real page.",
    });
    expect(briefed.composition.captions.map((c) => c.text)).toEqual([
      "Page-aware capture.",
      "The agent sees the real page.",
    ]);
    expect(briefed.composition.scenes[0].notes).toBe("Page-aware capture.");
    // "Suggest captions" is an agent job grounded in context; it lands as a new revision.
    const job = await done(
      s.videos.task("video.captions", id, {
        provider: "codex",
        compositionId: plain.composition.id,
      }).id,
    );
    expect(job.error).toBeNull();
    const view = await s.videos.view(id, plain.composition.id);
    expect(view.commit).toBe(job.result.commit);
    expect(view.composition.captions.map((c) => c.text)).toEqual([
      "Clicking Ship records the change",
      "The page updates in place",
    ]);
  }, 120000);
});
