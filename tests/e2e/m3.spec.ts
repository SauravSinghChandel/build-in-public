import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  port = 14312,
  origin = `http://127.0.0.1:${port}`;
let root: string, repo: string, server: ChildProcess, tokenUrl: string;
async function start(mode = "success") {
  server = spawn(process.execPath, ["apps/server/dist/cli.js", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      PLAYWRIGHT_BROWSERS_PATH: path.dirname(
        path.dirname(path.dirname(chromium.executablePath())),
      ),
      BIP_HOME: path.join(root, "data"),
      BIP_PORT: String(port),
      BIP_NO_OPEN: "1",
      NODE_ENV: "production",
      BIP_DEV_NO_AUTH: "0",
      BIP_CLAUDE_BIN: path.resolve("tests/fixtures/agents/fake.mjs"),
      BIP_CODEX_BIN: path.resolve("tests/fixtures/agents/fake.mjs"),
      BIP_FAKE_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tokenUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error(output || "Startup timeout")),
      15000,
    );
    server.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(
        /Open (http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.stderr!.on("data", (chunk) => (output += String(chunk)));
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Exit ${code}: ${output}`));
    });
  });
}
async function stop(signal: NodeJS.Signals = "SIGTERM") {
  if (server && !server.killed) {
    const done = new Promise<void>((resolve) =>
      server.once("exit", () => resolve()),
    );
    server.kill(signal);
    await done;
  }
}
test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m3-e2e-"));
  repo = path.join(root, "studio-project");
  await fs.mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Studio Author"], { cwd: repo });
  await exec("git", ["config", "user.email", "studio@example.com"], {
    cwd: repo,
  });
  for (let i = 1; i <= 5; i++) {
    await fs.writeFile(path.join(repo, "work.txt"), `Work ${i}\n`);
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-m", `Studio change ${i}`], { cwd: repo });
  }
  await start();
});
test.afterAll(async () => {
  await stop();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
test("upload → launch image → revisions → square export → X draft attachment", async ({
  page,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  await page.goto(tokenUrl);
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await page.getByLabel("Folder path").fill(repo);
  await page.getByRole("button", { name: "Find repositories" }).click();
  await page.getByLabel("Select all").check();
  await page.getByRole("button", { name: "Track 1 projects" }).click();
  await page
    .getByRole("link", { name: /studio-project.*studio-project/ })
    .click();
  await page.getByRole("tab", { name: "Media", exact: true }).click();
  await page
    .getByLabel("Upload image")
    .setInputFiles(
      "spikes/image/out/assets/f14b5d2ed8eb5b35cfa561c945801866ad66d9576e9cdfe069f279177a85514e.png",
    );
  await expect(page.locator(".media-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "New image", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New image", exact: true });
  await expect(
    create
      .getByRole("radiogroup", { name: "Source screenshot" })
      .getByRole("radio"),
  ).toHaveCount(1);
  await expect(
    create.getByRole("radio", { name: /\.png · / }).locator("img"),
  ).toBeVisible();
  await create.getByRole("radio", { name: "launch", exact: true }).click();
  await page.getByRole("button", { name: "Create image", exact: true }).click();
  const studio = page.getByRole("dialog", {
    name: "Image Studio",
    exact: true,
  });
  await expect(studio).toBeVisible();
  await expect(studio.locator("iframe")).toHaveAttribute("credentialless", "");
  expect(
    (await page.context().cookies()).find((c) => c.name === "bip_session")
      ?.path,
  ).toBe("/api");
  await expect(
    studio.getByText("✓ Screenshot unchanged", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const preview = studio.frameLocator('iframe[title="Image preview"]');
  await expect(preview.locator("h1")).toHaveText("A detail worth sharing");
  await studio
    .getByRole("textbox", { name: "Headline", exact: true })
    .fill("A quieter way to share the work");
  await expect(
    studio.getByRole("button", { name: "Restore revision 2", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(preview.locator("h1")).toHaveText(
    "A quieter way to share the work",
  );
  await studio.getByLabel("Canvas size").selectOption("square");
  await expect(
    studio.getByRole("button", { name: "Restore revision 3", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    studio.getByText("✓ Screenshot unchanged", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await studio
    .getByRole("textbox", { name: "Subhead", exact: true })
    .fill("One useful detail, shared with context.");
  await expect(
    studio.getByRole("button", { name: "Restore revision 4", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await studio.getByAltText("Revision 2", { exact: true }).click();
  await expect(
    studio.getByText("Previewing an earlier revision", { exact: true }),
  ).toBeVisible();
  await studio
    .getByRole("button", { name: "Restore revision 4", exact: true })
    .click();
  await expect(
    studio.getByRole("button", { name: "Restore revision 5", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const previewBox = await studio.locator("iframe").boundingBox();
  const stageBox = await studio.locator(".canvas-stage").boundingBox();
  expect(previewBox!.y).toBeGreaterThanOrEqual(stageBox!.y);
  expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(
    stageBox!.y + stageBox!.height + 1,
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    studio.getByRole("button", { name: "Export", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const downloaded = await download.path();
  const bytes = await fs.readFile(downloaded!);
  expect(bytes.readUInt32BE(16)).toBe(2160);
  expect(bytes.readUInt32BE(20)).toBe(2160);
  await page.screenshot({ path: "test-results/m3-image-studio.png" });
  await studio.getByRole("button", { name: "Close", exact: true }).click();
  await expect(studio).not.toBeVisible();
  await expect(page.locator(".media-tile")).toHaveCount(3);
  await page.getByRole("tab", { name: "Stories", exact: true }).click();
  await page.getByRole("button", { name: "New story", exact: true }).click();
  await page
    .getByPlaceholder("The one thing this story is about")
    .fill("Shipping the image studio");
  await page
    .getByRole("button", { name: "Draft X and LinkedIn", exact: true })
    .click();
  const x = page.getByRole("region", { name: "X draft", exact: true });
  await expect(
    x.getByRole("textbox", { name: "Part 1 of 3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Brief", exact: true }),
  ).toHaveValue("Shipping the image studio");
  await x.getByRole("button", { name: "Add image", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add image", exact: true });
  await picker.getByRole("button", { name: "Images", exact: true }).click();
  await picker
    .getByRole("button", { name: "Attach image", exact: true })
    .click();
  await expect(x.locator(".attached-image img")).toBeVisible();
  await x
    .getByLabel("Alt text", { exact: true })
    .fill("A screenshot framed below the image studio headline.");
  await x.getByLabel("Alt text", { exact: true }).blur();
  await x
    .getByRole("button", { name: "Review and publish", exact: true })
    .click();
  const publish = page.getByRole("dialog", {
    name: "Publish X post",
    exact: true,
  });
  await expect(
    publish.getByRole("link", { name: "Download image", exact: true }),
  ).toBeVisible();
  await expect(publish.locator(".attached-image img")).toBeVisible();
  await expect(
    publish.getByText("A screenshot framed below the image studio headline.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const box of await publish.getByRole("checkbox").all())
    await box.check();
  await publish.getByRole("button", { name: "Approve", exact: true }).click();
  // Open X carries text only, so it also puts the attached image on the clipboard.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .context()
    .route("https://x.com/**", (r) => r.fulfill({ body: "<title>X</title>" }));
  const popup = page.waitForEvent("popup");
  await publish.getByRole("link", { name: "Open X", exact: true }).click();
  const xTab = await popup;
  await xTab.waitForLoadState();
  expect(xTab.url()).toMatch(/^https:\/\/x\.com\/intent\/post\?text=/);
  await xTab.close();
  await expect(
    page.getByText(
      "Image copied. Click into the X composer and press Ctrl+V to attach it.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => (await navigator.clipboard.read())[0].types),
  ).toContain("image/png");
  await publish
    .getByLabel("Paste the published link")
    .fill("https://linkedin.com/posts/wrong-host");
  await expect(
    publish.getByText("Paste a link from x.com", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/m3-publish-image.png" });
  await publish.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: "Media", exact: true }).click();
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  const capture = page.getByRole("dialog", {
    name: "Capture screenshot",
    exact: true,
  });
  await capture.getByRole("textbox", { name: "URL", exact: true }).fill(origin);
  await capture
    .getByRole("textbox", { name: "Describe steps", exact: true })
    .fill("Wait for the page to settle");
  await capture
    .getByRole("button", { name: "Describe steps", exact: true })
    .click();
  const approval = capture.getByRole("checkbox", {
    name: "I reviewed and approve these steps",
    exact: true,
  });
  await expect(approval).toBeVisible({ timeout: 10000 });
  await expect(
    capture.getByRole("button", { name: "Run capture", exact: true }),
  ).toBeDisabled();
  await expect(
    capture.getByRole("textbox", { name: "Steps JSON", exact: true }),
  ).toHaveValue(/wait/);
  await approval.check();
  await capture
    .getByRole("button", { name: "Run capture", exact: true })
    .click();
  await expect(capture).not.toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Screenshots", exact: true }).click();
  await expect(page.locator(".media-tile")).toHaveCount(1);
  const status = (
    await exec("git", ["status", "--porcelain"], { cwd: repo })
  ).stdout.trim();
  expect(status).toBe("");
});
