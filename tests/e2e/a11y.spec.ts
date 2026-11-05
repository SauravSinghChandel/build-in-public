import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  port = 14316,
  origin = `http://127.0.0.1:${port}`;
let root: string, repo: string, server: ChildProcess, tokenUrl: string;
test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-a11y-e2e-"));
  await exec(process.execPath, ["examples/demo-project/create.mjs", root]);
  repo = path.join(root, "shiplog");
  server = spawn(process.execPath, ["apps/server/dist/cli.js", "start"], {
    env: {
      ...process.env,
      HOME: root,
      BIP_HOME: path.join(root, "data"),
      BIP_PORT: String(port),
      BIP_NO_OPEN: "1",
      NODE_ENV: "production",
      BIP_CLAUDE_BIN: path.resolve("tests/fixtures/agents/fake.mjs"),
      BIP_CODEX_BIN: path.resolve("tests/fixtures/agents/fake.mjs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tokenUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error(output)), 15000);
    server.stdout!.on("data", (b) => {
      output += String(b);
      const match = output.match(/Open (http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.stderr!.on("data", (b) => (output += String(b)));
    server.once("exit", (code) => reject(Error(`Server exited ${code}: ${output}`)));
  });
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});
/** Fails only on serious or critical axe violations (WCAG 2.1 A/AA). */
async function axe(page: Page, name: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    );
  expect(bad, `axe on ${name}`).toEqual([]);
}
async function theme(page: Page, mode: "dark" | "light") {
  await page.evaluate((m) => {
    localStorage.setItem("bip-appearance", m);
    document.documentElement.dataset.theme = m;
  }, mode);
}
async function tabTo(page: Page, selector: string, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (
      await page.evaluate(
        (s) => !!document.activeElement?.matches(s),
        selector,
      )
    )
      return;
  }
  throw Error(`Focus never reached ${selector}`);
}
test("key pages pass axe and work by keyboard", async ({ page }) => {
  test.setTimeout(90000);
  // No colour transitions, so contrast is measured on settled colours after a theme switch.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(tokenUrl);
  // 1. Projects: first-run onboarding, both themes.
  await expect(page.getByRole("heading", { name: "Set up Build in Public" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Claude Code/ })).toBeEnabled();
  for (const mode of ["dark", "light"] as const) {
    await theme(page, mode);
    await axe(page, `Projects onboarding (${mode})`);
  }
  await theme(page, "dark");
  await page.getByRole("button", { name: "Use Claude Code" }).click();
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).first().click();
  await page.getByRole("button", { name: "Add a single repository" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Repository path").fill(repo);
  await dialog.getByRole("button", { name: "Find repositories" }).click();
  await dialog.getByLabel("Select all").check();
  await dialog.getByRole("button", { name: "Track 1 projects" }).click();
  await expect(page.getByTestId("project-row")).toHaveCount(1);
  await axe(page, "Projects list");

  // Keyboard only: Projects → project Overview.
  await page.locator("body").focus();
  await tabTo(page, "a.project-name");
  const outline = await page.evaluate(
    () => getComputedStyle(document.activeElement!).outlineStyle,
  );
  expect(outline, "visible focus ring").not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  // 2. Project overview.
  await expect(
    page.getByRole("checkbox", { name: /Select Celebrate a 3-day streak/ }),
  ).toBeVisible();
  await axe(page, "Project overview");

  // 3. Story editor with drafts, then the publish sheet opened by keyboard.
  await page.getByRole("checkbox", { name: /Select Celebrate a 3-day streak/ }).check();
  await page.getByRole("button", { name: /Create story from 1 commit/ }).click();
  await page.getByRole("button", { name: "Propose 3 angles" }).click();
  await expect(page.getByText("A smaller daily workflow", { exact: true })).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Draft X and LinkedIn" }).click();
  const x = page.getByRole("region", { name: "X draft", exact: true });
  await expect(x.getByRole("textbox", { name: "Part 1 of 3", exact: true })).toBeVisible();
  await axe(page, "Story editor");
  const review = x.getByRole("button", { name: "Review and publish" });
  await review.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Secret scan: no matches")).toBeVisible();
  expect(await sheet.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await axe(page, "Publish sheet");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // 4. Settings → About shows tool versions.
  await page.goto(`${origin}/settings`);
  await page.getByRole("button", { name: "About", exact: true }).click();
  const versions = page.getByLabel("Versions");
  await expect(versions).toContainText("HyperFrames0.9.13");
  await expect(versions).toContainText("fake-agent 1.0.0");
  for (const mode of ["dark", "light"] as const) {
    await theme(page, mode);
    await axe(page, `Settings (${mode})`);
  }
});
