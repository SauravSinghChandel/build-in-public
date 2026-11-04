import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
let root: string, projects: string, tokenUrl: string, server: ChildProcess;
test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-e2e-"));
  projects = path.join(root, "projects");
  await fs.mkdir(projects);
  for (const [name, count] of [
    ["alpha", 5],
    ["beta", 3],
    ["gamma", 1],
  ] as const) {
    const cwd = path.join(projects, name);
    await fs.mkdir(cwd);
    await exec("git", ["init", "-b", "main"], { cwd });
    await exec("git", ["config", "user.name", "E2E Author"], { cwd });
    await exec("git", ["config", "user.email", "e2e@example.com"], { cwd });
    for (let n = 1; n <= count; n++) {
      await fs.writeFile(path.join(cwd, "work.txt"), `Work ${n}\n`);
      await exec("git", ["add", "."], { cwd });
      const date = `2026-11-0${n}T12:00:00Z`;
      await exec("git", ["commit", "-m", `${name} change ${n}`], {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
    }
  }
  server = spawn(process.execPath, ["apps/server/dist/cli.js", "start"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      BIP_HOME: path.join(root, "data"),
      BIP_PORT: "14310",
      BIP_NO_OPEN: "1",
      NODE_ENV: "production",
      BIP_DEV_NO_AUTH: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tokenUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(Error("Server startup timed out: " + output)),
      15000,
    );
    server.stdout!.on("data", (b) => {
      output += String(b);
      const match = output.match(
        /Open (http:\/\/127\.0\.0\.1:14310\/\?token=[a-f0-9]+)/,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.stderr!.on("data", (b) => {
      output += String(b);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(Error(`Server exited ${code}: ${output}`));
    });
  });
});
test.afterAll(async () => {
  if (server && !server.killed) {
    const exited = new Promise<void>((resolve) =>
      server.once("exit", () => resolve()),
    );
    server.kill("SIGTERM");
    await exited;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});
test("foundation core loop: discover, track, timeline, share, context, appearance", async ({
  page,
}) => {
  await page.goto(tokenUrl);
  await expect(
    page.getByRole("heading", {
      name: "Add the folder where your projects live",
    }),
  ).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:14310/");
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await page.getByLabel("Folder path").fill(projects);
  await page.getByRole("button", { name: "Find repositories" }).click();
  await expect(page.getByText("3 repositories found")).toBeVisible();
  await page
    .locator(".repo-choice")
    .filter({ hasText: "alpha" })
    .getByRole("checkbox")
    .check();
  await page
    .locator(".repo-choice")
    .filter({ hasText: "beta" })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Track 2 projects" }).click();
  const rows = page.getByTestId("project-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("alpha");
  await expect(rows.nth(0)).toContainText("5 unshared");
  await expect(rows.nth(1)).toContainText("beta");
  await expect(rows.nth(1)).toContainText("3 unshared");
  await page.getByRole("link", { name: /alpha.*projects\/alpha/ }).click();
  await expect(
    page.getByRole("heading", { name: "Unshared work" }),
  ).toBeVisible();
  await expect(page.locator(".day-heading")).toHaveCount(5);
  await page.screenshot({
    path: "test-results/m1-dark-overview.png",
    fullPage: true,
  });
  await page
    .getByRole("checkbox", { name: "Select alpha change 5", exact: true })
    .check();
  await expect(
    page.getByRole("button", { name: "Create story from 1 commit" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("alpha change 5", { exact: true })).toBeVisible();
  await page
    .locator("article.commit")
    .filter({ hasText: "alpha change 3" })
    .getByRole("button", { name: "Commit actions" })
    .click();
  await page
    .getByRole("menuitem", { name: "Mark everything up to here as shared" })
    .click();
  await expect(page.locator(".section-heading").first()).toContainText(
    "2 commits",
  );
  await expect(page.locator(".shared-marker")).toBeVisible();
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Shareable notes", exact: true })
    .fill("These are my shareable project notes.");
  await page
    .getByRole("textbox", { name: "Private notes", exact: true })
    .fill("Avoid mentioning customer names.");
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Shareable notes", exact: true }),
  ).toHaveValue("These are my shareable project notes.");
  await page.reload();
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Shareable notes", exact: true }),
  ).toHaveValue("These are my shareable project notes.");
  await expect(
    page.getByRole("textbox", { name: "Private notes", exact: true }),
  ).toHaveValue("Avoid mentioning customer names.");
  await page
    .locator(".rail")
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  await expect(rows.nth(0)).toContainText("beta");
  await expect(rows.nth(1)).toContainText("alpha");
  await expect(rows.nth(1)).toContainText("2 unshared");
  await page
    .locator(".rail")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Light", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: "test-results/m1-light-settings.png",
    fullPage: true,
  });
  await page
    .locator(".rail")
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  await page.getByRole("link", { name: /alpha.*projects\/alpha/ }).click();
  await expect(page.getByText("alpha change 5", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/m1-overview.png",
    fullPage: true,
  });
});
