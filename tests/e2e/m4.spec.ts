import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  port = 14313;
let root: string,
  repo: string,
  tokenUrl: string,
  server: ChildProcess,
  fixture: Server,
  fixtureUrl: string;
test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m4-e2e-"));
  repo = path.join(root, "video-demo");
  await fs.mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await fs.writeFile(path.join(repo, "work.txt"), "Video studio");
  await exec("git", ["add", "."], { cwd: repo });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "Video studio",
    ],
    { cwd: repo },
  );
  fixture = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      '<style>body{background:#263141;color:white;font:32px sans-serif}button{padding:40px;margin:100px}b{display:block;animation:p .8s infinite alternate}@keyframes p{to{transform:translateX(100px)}}</style><button id="go" class="cursor-pointer" onclick="this.textContent=\'Shipped\'">Ship it</button><b>Local fixture</b>',
    );
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as any).port}`;
  server = spawn(process.execPath, ["apps/server/dist/cli.js", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      PLAYWRIGHT_BROWSERS_PATH: path.dirname(
        path.dirname(path.dirname(chromium.executablePath())),
      ),
      HYPERFRAMES_BROWSER_PATH: chromium.executablePath(),
      BIP_HOME: path.join(root, "data"),
      BIP_PORT: String(port),
      BIP_NO_OPEN: "1",
      NODE_ENV: "production",
      BIP_CLAUDE_BIN: path.resolve("tests/fixtures/agents/fake.mjs"),
      BIP_CODEX_BIN: path.resolve("tests/fixtures/agents/fake.mjs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tokenUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error(output)), 15000);
    server.stdout!.on("data", (b) => {
      output += String(b);
      const m = output.match(
        /Open (http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/,
      );
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    server.stderr!.on("data", (b) => (output += String(b)));
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Exit ${code}: ${output}`));
    });
  });
});
test.afterAll(async () => {
  if (server && !server.killed) {
    const done = new Promise<void>((r) => server.once("exit", () => r()));
    server.kill("SIGTERM");
    await done;
  }
  if (fixture) await new Promise<void>((r) => fixture.close(() => r()));
  if (root) await fs.rm(root, { recursive: true, force: true });
});
test("story → approved demo capture → caption revision → playable preview → X video publish sheet", async ({
  page,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  await page.goto(tokenUrl);
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await page.getByLabel("Folder path").fill(repo);
  await page.getByRole("button", { name: "Find repositories" }).click();
  await page.getByLabel("Select all").check();
  await page.getByRole("button", { name: "Track 1 projects" }).click();
  await page.getByRole("link", { name: /video-demo.*video-demo/ }).click();
  await page.getByRole("tab", { name: "Stories", exact: true }).click();
  await page.getByRole("button", { name: "New story", exact: true }).click();
  await page
    .getByPlaceholder("The one thing this story is about")
    .fill("A sharper demo capture");
  await page
    .getByRole("button", { name: "Draft X and LinkedIn", exact: true })
    .click();
  const x = page.getByRole("region", { name: "X draft", exact: true });
  await expect(
    x.getByRole("textbox", { name: "Part 1 of 3", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add video", exact: true }).click();
  await page
    .getByRole("button", { name: "Record a demo", exact: true })
    .click();
  const record = page.getByRole("dialog", {
    name: "Record a demo",
    exact: true,
  });
  await record.getByLabel("URL", { exact: true }).fill(fixtureUrl);
  await record
    .getByLabel("Describe the demo")
    .fill("Wait one second, click Ship it, hold two seconds.");
  await record.getByRole("button", { name: "Generate steps" }).click();
  await expect(record.getByLabel("Steps JSON")).toHaveValue(/#go/);
  await expect(
    record.getByRole("button", { name: "Run recording" }),
  ).toBeDisabled();
  await record.getByLabel("I reviewed and approve these steps").check();
  await record.getByRole("button", { name: "Run recording" }).click();
  const studio = page.getByRole("dialog", {
    name: "Video Studio",
    exact: true,
  });
  await expect(studio).toBeVisible({ timeout: 30000 });
  await expect(
    studio.getByRole("textbox", { name: "Caption 1", exact: true }),
  ).toBeEnabled({ timeout: 90000 });
  const firstSrc = await studio.locator("video").getAttribute("src");
  await studio
    .getByRole("textbox", { name: "Caption 1", exact: true })
    .fill("A measured, sharper recording");
  await studio.getByRole("textbox", { name: "Caption 1", exact: true }).blur();
  await expect(
    studio.getByRole("button", { name: "Restore revision 2", exact: true }),
  ).toBeVisible();
  await expect(studio.locator("video")).not.toHaveAttribute(
    "src",
    firstSrc || "",
    { timeout: 90000 },
  );
  await expect
    .poll(
      () =>
        studio
          .locator("video")
          .evaluate((v) => (v as HTMLVideoElement).duration),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
  await studio.locator("video").evaluate((v) => (v as HTMLVideoElement).play());
  await expect
    .poll(() =>
      studio
        .locator("video")
        .evaluate((v) => (v as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await studio.getByLabel("Frame scrubber").fill("30");
  await expect(
    studio.getByRole("button", { name: "Attach to X post", exact: true }),
  ).toBeEnabled({ timeout: 90000 });
  await studio
    .getByRole("button", { name: "Attach to X post", exact: true })
    .click();
  await expect(
    studio.getByRole("link", { name: "Download final MP4" }),
  ).toBeVisible({ timeout: 90000 });
  await expect
    .poll(
      () =>
        studio
          .locator("video")
          .evaluate((v) => (v as HTMLVideoElement).readyState),
      { timeout: 30000 },
    )
    .toBeGreaterThanOrEqual(2);
  await studio.locator("video").evaluate((v) => {
    const player = v as HTMLVideoElement;
    player.pause();
    player.currentTime = 1.5;
  });
  await expect
    .poll(() =>
      studio.locator("video").evaluate((v) => (v as HTMLVideoElement).seeking),
    )
    .toBe(false);
  await studio.locator(".studio-right").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: "test-results/m4-video-studio.png" });
  await studio.getByRole("button", { name: "Close", exact: true }).click();
  await expect(x.getByText("Video", { exact: true })).toBeVisible();
  await x
    .getByRole("button", { name: "Review and publish", exact: true })
    .click();
  const publish = page.getByRole("dialog", {
    name: "Publish X post",
    exact: true,
  });
  await expect(
    publish.getByRole("link", { name: "Download video", exact: true }),
  ).toBeVisible();
  await expect(publish.locator("video")).toBeVisible();
  await page.screenshot({ path: "test-results/m4-publish-video.png" });
});
