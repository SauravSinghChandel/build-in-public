import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  port = 14311,
  origin = `http://127.0.0.1:${port}`;
let root: string, repo: string, server: ChildProcess, tokenUrl: string;
async function start(mode = "success") {
  server = spawn(process.execPath, ["apps/server/dist/cli.js", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m2-e2e-"));
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
test("post studio, assisted publishing and interrupted job resume", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto(tokenUrl);
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await page.getByLabel("Folder path").fill(repo);
  await page.getByRole("button", { name: "Find repositories" }).click();
  await page.getByLabel("Select all").check();
  await page.getByRole("button", { name: "Track 1 projects" }).click();
  await page
    .getByRole("link", { name: /studio-project.*studio-project/ })
    .click();
  await page
    .getByRole("checkbox", { name: "Select Studio change 5", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Select Studio change 3", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("checkbox", { name: "Select Studio change 4", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Create story from 3 commits" })
    .click();
  await page.getByRole("button", { name: "Propose 3 angles" }).click();
  await expect(
    page.getByText("A smaller daily workflow", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Draft X and LinkedIn" }).click();
  const x = page.getByRole("region", { name: "X draft", exact: true }),
    li = page.getByRole("region", { name: "LinkedIn draft", exact: true });
  await expect(
    x.getByRole("textbox", { name: "Part 1 of 3", exact: true }),
  ).toBeVisible();
  await expect(li.getByLabel("LinkedIn text")).toBeVisible();
  await x.getByRole("button", { name: "Shorten", exact: true }).click();
  await expect(
    x.getByText("Revision 2 · agent · Shorten", { exact: true }),
  ).toBeVisible();
  await expect(
    x.getByRole("textbox", { name: "Post", exact: true }),
  ).toHaveValue("I simplified my daily workflow by removing a repeated step.");
  await x
    .getByRole("button", { name: "Restore revision 1", exact: true })
    .click();
  await expect(
    x.getByText("Revision 3 · user · Restored revision 1", { exact: true }),
  ).toBeVisible();
  await x.getByRole("button", { name: "Review and publish" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Secret scan: no matches")).toBeVisible();
  for (const box of await sheet.getByRole("checkbox").all()) await box.check();
  await sheet.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    sheet.getByRole("link", { name: "Open X", exact: true }),
  ).toHaveAttribute("href", /^https:\/\/x.com\/intent\/post\?text=/);
  await sheet
    .getByLabel("Paste the published link")
    .fill("https://x.com/studio/status/123");
  await sheet.getByRole("button", { name: "Mark as published" }).click();
  await expect(sheet).not.toBeVisible();
  await expect(x.getByText("published", { exact: true })).toBeVisible();
  await page
    .locator(".rail")
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  await expect(page.getByTestId("project-row")).toContainText("Up to date");
  await expect(page.getByTestId("project-row")).toContainText(
    "Last post Today",
  );
  // Restart with a deliberately slow fresh agent run. Kill after its session ID has arrived.
  await stop();
  await start("slow");
  await page.goto(tokenUrl);
  await page
    .getByRole("link", { name: /studio-project.*studio-project/ })
    .click();
  await page.getByRole("tab", { name: "Stories", exact: true }).click();
  await page.getByRole("link", { name: /A smaller daily workflow/ }).click();
  await x.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(x.getByRole("status")).toContainText("Running");
  await expect
    .poll(async () => {
      const jobs = await (await page.request.get(origin + "/api/jobs")).json();
      return jobs.find(
        (j: any) =>
          j.type === "post.edit" && j.payload.instruction === "Expand",
      )?.status;
    })
    .toBe("running");
  // Wait for persisted session via progress text (no text is emitted until resumed).
  await page.waitForTimeout(350);
  const editorUrl = page.url();
  await stop("SIGKILL");
  await start("slow");
  await page.goto(tokenUrl);
  await page.goto(editorUrl);
  await expect(x.getByRole("status")).toContainText("Interrupted");
  await x.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    x.getByText("Revision 4 · agent · Expand", { exact: true }),
  ).toBeVisible();
  await expect(
    x.getByRole("textbox", { name: "Post", exact: true }),
  ).toHaveValue("I built a smaller workflow around the detail that mattered.");
  // Repeat recovery for an initial two-platform draft, not just an edit.
  await page.getByRole("tab", { name: "Stories", exact: true }).click();
  await page.getByRole("button", { name: "New story", exact: true }).click();
  await page
    .getByPlaceholder("The one thing this story is about")
    .fill("A second story");
  await page
    .getByRole("button", { name: "Draft X and LinkedIn", exact: true })
    .click();
  await expect(page.locator(".story-editor .job-feedback")).toContainText(
    "Running",
  );
  await page.waitForTimeout(350);
  const freshDraftUrl = page.url();
  await stop("SIGKILL");
  await start("slow");
  await page.goto(tokenUrl);
  await page.goto(freshDraftUrl);
  await expect(page.locator(".story-editor .job-feedback")).toContainText(
    "Interrupted",
  );
  await page
    .locator(".story-editor")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect(
    x.getByRole("textbox", { name: "Part 1 of 3", exact: true }),
  ).toBeVisible();
  await expect(li.getByLabel("LinkedIn text")).toBeVisible();
  await page.screenshot({
    path: "test-results/m2-story-editor.png",
    fullPage: true,
  });
  // URL tabs and ordinary browser back stay in sync.
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(page).toHaveURL(/\/context$/);
  await page.goBack();
  await expect(page.getByLabel("Story title")).toBeVisible();
});
