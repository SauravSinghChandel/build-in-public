import { test, expect, chromium, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { startPlatformMock, type PlatformMock } from "../mocks/platforms.js";
const exec = promisify(execFile),
  port = 14315;
let root: string, repo: string, server: ChildProcess, tokenUrl: string, mock: PlatformMock;

test.beforeAll(async () => {
  mock = await startPlatformMock();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m5-e2e-"));
  repo = path.join(root, "studio-project");
  await fs.mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Studio Author"], { cwd: repo });
  await exec("git", ["config", "user.email", "studio@example.com"], { cwd: repo });
  for (let i = 1; i <= 3; i++) {
    await fs.writeFile(path.join(repo, "work.txt"), `Work ${i}\n`);
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-m", `Studio change ${i}`], { cwd: repo });
  }
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
      BIP_FAKE_MODE: "success",
      // Never the real platforms or the real keychain.
      BIP_X_API_BASE: mock.origin,
      BIP_X_AUTH_BASE: mock.origin,
      BIP_LINKEDIN_API_BASE: mock.origin,
      BIP_LINKEDIN_AUTH_BASE: mock.origin,
      BIP_SECRET_STORE: "file",
      // Fast scheduler and a server clock 45 s ahead: "1 minute ahead" is due in ~15 s.
      BIP_SCHEDULER_INTERVAL_MS: "1000",
      BIP_TEST_CLOCK_OFFSET_MS: "45000",
      BIP_PUBLISH_BACKOFF_MS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tokenUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error(output || "Startup timeout")), 15000);
    server.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/Open (http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/);
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
});
test.afterAll(async () => {
  if (server && !server.killed) {
    const done = new Promise<void>((r) => server.once("exit", () => r()));
    server.kill("SIGTERM");
    await done;
  }
  await mock?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function connect(page: Page, name: "X" | "LinkedIn", clientId: string, secret?: string) {
  await page.locator(".rail").getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  const section = page.getByRole("region", { name: `${name} account`, exact: true });
  await expect(section.getByText(/\/oauth\/(x|linkedin)\/callback/)).toBeVisible();
  await section.getByLabel("Client ID").fill(clientId);
  if (secret) await section.getByLabel(/Client Secret/).fill(secret);
  await section.getByRole("button", { name: `Connect ${name}`, exact: true }).click();
  // The mock platform's authorize page, then the real callback.
  await expect(page.getByRole("heading", { name: `Authorize ${name} (mock)` })).toBeVisible();
  await page.getByRole("link", { name: "Authorize app" }).click();
  await expect(page).toHaveURL(/\/settings\?section=accounts&connected=/);
  return page.getByRole("region", { name: `${name} account`, exact: true });
}

test("connect accounts, post now with an image, schedule a LinkedIn post", async ({ page }) => {
  test.setTimeout(150000);
  page.setDefaultTimeout(15000);
  await page.goto(tokenUrl);
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await page.getByLabel("Folder path").fill(repo);
  await page.getByRole("button", { name: "Find repositories" }).click();
  await page.getByLabel("Select all").check();
  await page.getByRole("button", { name: "Track 1 projects" }).click();

  const xAccount = await connect(page, "X", "mock-x-client");
  await expect(xAccount.getByText("Connected as")).toContainText("@mockmaker");
  await expect(page.getByRole("note")).toContainText("encrypted file");
  const liAccount = await connect(page, "LinkedIn", "mock-li-client", "mock-li-secret");
  await expect(liAccount.getByText("Connected as")).toContainText("Mock Person");
  await expect(liAccount.getByText(/^Reconnect by /)).toBeVisible();

  await page.locator(".rail").getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: /studio-project.*studio-project/ }).click();
  await page.getByRole("tab", { name: "Media", exact: true }).click();
  await page
    .getByLabel("Upload image")
    .setInputFiles(
      "spikes/image/out/assets/f14b5d2ed8eb5b35cfa561c945801866ad66d9576e9cdfe069f279177a85514e.png",
    );
  await expect(page.locator(".media-tile")).toHaveCount(1, { timeout: 20000 });
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select Studio change 3", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select Studio change 1", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Create story from 3 commits" }).click();
  await page.getByRole("button", { name: "Propose 3 angles" }).click();
  await expect(page.getByText("A smaller daily workflow", { exact: true })).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Draft X and LinkedIn" }).click();
  const x = page.getByRole("region", { name: "X draft", exact: true }),
    li = page.getByRole("region", { name: "LinkedIn draft", exact: true });
  await expect(x.getByRole("textbox", { name: "Part 1 of 3", exact: true })).toBeVisible();

  // X: attach the image, approve, Post now via the connected account.
  await x.getByRole("button", { name: "Add image", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add image", exact: true });
  await picker.getByRole("button", { name: "Uploads", exact: true }).click();
  await picker.getByRole("button", { name: "Attach image", exact: true }).click();
  await expect(x.locator(".attached-image img")).toBeVisible();
  await x.getByRole("button", { name: "Review and publish", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Publish X post", exact: true });
  await expect(sheet.getByText("Secret scan: no matches")).toBeVisible();
  for (const box of await sheet.getByRole("checkbox").all()) await box.check();
  await sheet.getByRole("button", { name: "Approve", exact: true }).click();
  // Assisted options remain alongside direct posting.
  await expect(sheet.getByRole("link", { name: "Open X", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Post now via @mockmaker", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Post to X as @mockmaker?", exact: true });
  await expect(confirm.locator(".post-preview")).toHaveCount(3);
  await expect(confirm.locator(".attached-image img")).toBeVisible();
  await expect(confirm.getByText("Account: @mockmaker")).toBeVisible();
  await confirm.getByRole("button", { name: "Confirm and post", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  const published = x.getByRole("link", { name: "Published post", exact: true });
  await expect(published).toHaveAttribute("href", /^https:\/\/x\.com\/mockmaker\/status\/\d+$/, {
    timeout: 20000,
  });
  await expect(x.getByText("published", { exact: true })).toBeVisible();
  expect(mock.tweets).toHaveLength(3);
  expect(mock.tweets[0].mediaIds).toHaveLength(1);
  expect(mock.tweets[1].replyTo).toBe(mock.tweets[0].id);

  // LinkedIn: approve, schedule one minute ahead; the scheduler publishes it.
  await li.getByRole("button", { name: "Review and publish", exact: true }).click();
  const liSheet = page.getByRole("dialog", { name: "Publish LinkedIn post", exact: true });
  await expect(liSheet.getByText(/Secret scan/)).toBeVisible();
  for (const box of await liSheet.getByRole("checkbox").all()) await box.check();
  await liSheet.getByRole("button", { name: "Approve", exact: true }).click();
  await liSheet.getByRole("button", { name: "Schedule…", exact: true }).click();
  await expect(liSheet.getByText("only while Build in Public is running")).toBeVisible();
  const inAMinute = await page.evaluate(() => {
    const d = new Date(Date.now() + 60_000),
      p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });
  await liSheet.getByLabel(/^Post at/).fill(inAMinute);
  await liSheet.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(liSheet.getByText(/^Scheduled for /)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(li.getByText("scheduled", { exact: true })).toBeVisible();
  await expect(li.getByRole("link", { name: "Published post", exact: true })).toHaveAttribute(
    "href",
    /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:\d+\/$/,
    { timeout: 40000 },
  );
  expect(mock.linkedinPosts).toHaveLength(1);
  expect(mock.count("POST", "/2/tweets")).toBe(3);

  // The Scheduled view is now empty and says when the scheduler runs.
  await page.locator(".rail").getByRole("link", { name: "Content", exact: true }).click();
  await page.getByRole("tab", { name: "Scheduled", exact: true }).click();
  await expect(page.getByText("Nothing scheduled.", { exact: false })).toBeVisible();
  await expect(page.getByText(/only while Build in Public is running/)).toBeVisible();
});
