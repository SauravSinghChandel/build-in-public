import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chromium } from "playwright";
import {
  Composition,
  CaptureInput,
  CaptureStep,
  imageSizes,
  type CompositionData,
  type CompositionView,
  type ImageRevision,
  type JobView,
} from "@bip/shared";
import type { Content } from "../content.js";
import { agentSchema, parseAgentOutput } from "../agents/schema.js";
import { provider, type ProviderId } from "../agents/index.js";
import { git } from "../git.js";
import { atomicJsonWrite } from "../bip/store.js";
import { Assets, safeFile, thumbDir } from "./assets.js";
import { RenderOrigin, renderAndCheck } from "./render.js";
import { validateComposition } from "./validate.js";
const templates = fileURLToPath(
  new URL("../../../../packages/templates/image/", import.meta.url),
);
const identity = [
  "-c",
  "user.name=Build in Public",
  "-c",
  "user.email=bip@localhost",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
];
const uuid = z.uuid();
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export class ImageStudio {
  readonly assets: Assets;
  readonly origin = new RenderOrigin();
  private chains = new Map<string, Promise<unknown>>();
  constructor(readonly content: Content) {
    this.assets = new Assets(content.projects);
    content.imageHandler = async (j, s, e) => {
      const result = await this.run(j, s, e);
      await fs.rm(path.join(content.home, "workspaces", j.id), {
        recursive: true,
        force: true,
      });
      return result;
    };
  }
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) || Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.chains.set(key, next);
    return next;
  }
  async dir(project: string, id: string) {
    uuid.parse(id);
    const s = await this.content.projects.store(project);
    return safeFile(s.root, "compositions/" + id);
  }
  async writable(project: string) {
    const s = await this.content.projects.store(project);
    if (s.readOnly) throw Error("Project is read only");
    return s;
  }
  async config(project: string, id: string) {
    return Composition.parse(
      JSON.parse(
        await fs.readFile(
          await safeFile(await this.dir(project, id), "composition.json"),
          "utf8",
        ),
      ),
    );
  }
  async commit(dir: string, instruction: string) {
    await git(dir, [...identity, "add", "--all"]);
    await git(dir, [
      ...identity,
      "commit",
      "--allow-empty",
      "-m",
      instruction.slice(0, 10000),
    ]);
    return (await git(dir, ["rev-parse", "HEAD"])).trim();
  }
  async revisions(dir: string): Promise<ImageRevision[]> {
    return (await git(dir, ["log", "--format=%H%x09%cI%x09%s"]))
      .trim()
      .split("\n")
      .filter(Boolean)
      .reverse()
      .map((line) => {
        const [commit, createdAt, ...msg] = line.split("\t");
        return { commit, createdAt, instruction: msg.join("\t") };
      });
  }
  private snapshots = new Map<
    string,
    Promise<{ dir: string; commit: string; config: CompositionData }>
  >();
  async snapshot(project: string, id: string, revision?: string) {
    const dir = await this.dir(project, id);
    const commit = commitSchema.parse(
      revision || (await git(dir, ["rev-parse", "HEAD"])).trim(),
    );
    // Require a real revision reachable from this composition, rather than arbitrary git expressions.
    if (!(await this.revisions(dir)).some((r) => r.commit === commit))
      throw Error("Unknown revision");
    const key = project + id + commit;
    const existing = this.snapshots.get(key);
    if (existing) return existing;
    const task = (async () => {
      const dest = path.join(
        this.content.home,
        "previews",
        project,
        id,
        commit,
      );
      await fs.mkdir(dest, { recursive: true });
      const files = (await git(dir, ["ls-tree", "-r", "--name-only", commit]))
        .trim()
        .split("\n");
      for (const file of files) {
        if (!file) continue;
        const target = await safeFile(dest, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const { execFile } = await import("node:child_process");
        const bytes = await new Promise<Buffer>((resolve, reject) =>
          execFile(
            "git",
            ["show", `${commit}:${file}`],
            { cwd: dir, encoding: "buffer", maxBuffer: 1024 * 1024 + 1 },
            (e, out) => (e ? reject(e) : resolve(out)),
          ),
        );
        await fs.writeFile(target, bytes);
      }
      return {
        dir: dest,
        commit,
        config: Composition.parse(
          JSON.parse(
            await fs.readFile(path.join(dest, "composition.json"), "utf8"),
          ),
        ),
      };
    })();
    this.snapshots.set(key, task);
    try {
      return await task;
    } catch (e) {
      this.snapshots.delete(key);
      throw e;
    }
  }

  async sources(project: string, c: CompositionData) {
    const result = new Map<string, { file: string; mime: string }>();
    for (const sha of c.sources) {
      const { item } = await this.assets.get(project, sha);
      result.set(sha, {
        file: await this.assets.file(project, sha),
        mime: item.mime,
      });
    }
    return result;
  }
  async view(
    project: string,
    id: string,
    revision?: string,
  ): Promise<CompositionView> {
    const snap = await this.snapshot(project, id, revision),
      sources = await this.sources(project, snap.config);
    const previewUrl = await this.origin.mount({
      dir: snap.dir,
      config: snap.config,
      sources,
    });
    return {
      composition: snap.config,
      commit: snap.commit,
      revisions: await this.revisions(await this.dir(project, id)),
      previewUrl,
    };
  }
  async list(project: string) {
    const s = await this.content.projects.store(project);
    const dir = await safeFile(s.root, "compositions");
    const entries = await fs.readdir(dir).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    return Promise.all(entries.map((id) => this.view(project, id)));
  }
  async create(
    project: string,
    input: {
      preset: CompositionData["preset"];
      sources: string[];
      storyId?: string;
    },
  ) {
    const s = await this.writable(project);
    for (const sha of input.sources) await this.assets.get(project, sha);
    const id = randomUUID(),
      dir = await this.dir(project, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.cp(path.join(templates, input.preset), dir, { recursive: true });
    const config = Composition.parse({
      schemaVersion: 1,
      id,
      type: "image",
      title: "Untitled image",
      preset: input.preset,
      width: 1200,
      height: 675,
      sources:
        input.preset === "comparison"
          ? [input.sources[0], input.sources[1] || input.sources[0]]
          : input.sources.slice(0, 1),
      storyId: input.storyId,
      slots: {
        headline: "A detail worth sharing",
        subhead: "Built with intention, down to the last pixel.",
        accent: "#e8b04b",
        background: "radial",
        frame: "browser",
        padding: 40,
        shadow: 40,
        annotations:
          input.preset === "technical"
            ? ["The starting point", "A useful detail", "The result"]
            : [],
      },
    });
    await atomicJsonWrite(path.join(dir, "composition.json"), config);
    await git(dir, [...identity, "init", "-b", "main"]);
    await this.commit(dir, "Create " + input.preset + " image");
    if (input.storyId) {
      const story = await s.readStory(input.storyId);
      await s.updateStory(input.storyId, {
        compositionIds: [...story.compositionIds, id],
      });
    }
    return this.view(project, id);
  }
  async update(
    project: string,
    id: string,
    patch: Partial<CompositionData>,
    instruction = "Edit image slots",
  ) {
    return this.serial(project + id, async () => {
      await this.writable(project);
      const dir = await this.dir(project, id),
        old = await this.config(project, id);
      const next = Composition.parse({
        ...old,
        ...patch,
        id,
        type: "image",
        schemaVersion: 1,
      });
      await this.sources(project, next);
      if (next.preset !== old.preset) {
        await fs.cp(path.join(templates, next.preset), dir, {
          recursive: true,
        });
        if (next.preset === "comparison" && next.sources.length < 2)
          next.sources.push(next.sources[0]);
      }
      if (JSON.stringify(next) !== JSON.stringify(old)) {
        await atomicJsonWrite(path.join(dir, "composition.json"), next);
        await this.commit(dir, instruction);
      }
      return this.view(project, id);
    });
  }
  async restore(project: string, id: string, revision: string) {
    return this.serial(project + id, async () => {
      await this.writable(project);
      const snap = await this.snapshot(project, id, revision);
      const errors = await validateComposition(snap.dir);
      if (errors.length) throw Error(errors.join("\n"));
      await this.replace(await this.dir(project, id), snap.dir);
      await this.commit(await this.dir(project, id), "Restore " + revision);
      return this.view(project, id);
    });
  }
  private async replace(dest: string, source: string) {
    for (const e of await fs.readdir(dest))
      if (e !== ".git")
        await fs.rm(await safeFile(dest, e), { recursive: true, force: true });
    await fs.cp(source, dest, {
      recursive: true,
      filter: (p) =>
        path.basename(p) !== ".git" && path.basename(p) !== "sources",
    });
  }
  async render(
    project: string,
    id: string,
    options: {
      commit?: string;
      size?: keyof typeof imageSizes;
      format?: "png" | "jpeg";
    } = {},
  ) {
    return this.serial("renderer", () => this.renderNow(project, id, options));
  }
  private async renderNow(
    project: string,
    id: string,
    options: {
      commit?: string;
      size?: keyof typeof imageSizes;
      format?: "png" | "jpeg";
    } = {},
  ) {
    const snap = await this.snapshot(project, id, options.commit);
    if (options.size) {
      const [width, height] = imageSizes[options.size];
      snap.config = { ...snap.config, width, height };
    }
    const errors = await validateComposition(snap.dir);
    if (errors.length) throw Error(errors.join("\n"));
    const sources = await this.sources(project, snap.config),
      url = await this.origin.mount({
        dir: snap.dir,
        config: snap.config,
        sources,
      });
    const render = await renderAndCheck(
      url,
      snap.config,
      sources,
      options.format,
    );
    return { ...render, commit: snap.commit };
  }
  async thumbnail(project: string, id: string, commit?: string) {
    const v = await this.snapshot(project, id, commit);
    const cache = thumbDir();
    await fs.mkdir(cache, { recursive: true });
    const file = path.join(cache, `composition-${id}-${v.commit}.png`);
    try {
      return await fs.readFile(file);
    } catch {}
    return this.serial("thumb:" + id + v.commit, async () => {
      try {
        return await fs.readFile(file);
      } catch {}
      const rendered = await this.render(project, id, { commit: v.commit });
      const b = await chromium.launch({ chromiumSandbox: false });
      try {
        const page = await b.newPage({
          viewport: { width: 320, height: 200 },
          deviceScaleFactor: 1,
        });
        await page.setContent(
          "<style>body{margin:0;background:#15171c;height:100vh;display:grid;place-items:center}img{max-width:100%;max-height:100%}</style><img>",
        );
        await page.locator("img").evaluate(
          async (e, data) => {
            const img = e as HTMLImageElement;
            img.src = data;
            await img.decode();
          },
          "data:image/png;base64," + rendered.bytes.toString("base64"),
        );
        const bytes = await page.screenshot();
        await fs.writeFile(file, bytes);
        return bytes;
      } finally {
        await b.close();
      }
    });
  }
  async export(
    project: string,
    id: string,
    options: {
      size?: keyof typeof imageSizes;
      format?: "png" | "jpeg";
      commit?: string;
    },
  ) {
    await this.writable(project);
    const result = await this.render(project, id, options);
    if (!result.fidelity.pass) throw Error(result.fidelity.errors.join("\n"));
    const asset = await this.assets.put(project, result.bytes, "image_render", {
      type: "render",
      compositionId: id,
      commit: result.commit,
    });
    const s = await this.content.projects.store(project),
      file = await safeFile(
        s.root,
        `renders/${id}/${result.commit}${options.size ? "-" + options.size : ""}.${options.format === "jpeg" ? "jpg" : "png"}`,
      );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, result.bytes);
    return { ...result, asset };
  }
  task(type: string, project: string, payload: Record<string, unknown>) {
    return this.content.jobs.enqueue(
      type,
      project,
      `${project}:image:${payload.compositionId || "capture"}`,
      payload,
    );
  }
  private async agent(
    job: JobView,
    workspace: string,
    prompt: string,
    schema: z.ZodType,
    signal: AbortSignal,
    write = false,
  ) {
    const actualWorkspace = await fs.realpath(workspace);
    if (
      this.content.projects
        .registry()
        .some(
          (p) =>
            actualWorkspace === p.path ||
            actualWorkspace.startsWith(p.path + path.sep),
        )
    )
      throw Error("Agent workspace must be outside every tracked repository");
    const runId = randomUUID(),
      logPath = path.join(this.content.home, "logs/agents", runId + ".jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    this.content.db
      .prepare(
        "INSERT INTO agent_runs(id,job_id,provider,cwd,log_path) VALUES(?,?,?,?,?)",
      )
      .run(runId, job.id, job.payload.provider, workspace, logPath);
    let result: unknown,
      completed = false;
    const errors: string[] = [];
    const chunks: string[] = [];
    try {
      for await (const event of provider(
        job.payload.provider as ProviderId,
      ).run({
        task: job.type,
        workspace,
        prompt,
        signal,
        writeDirs: write ? [workspace] : [],
        outputSchema: agentSchema(schema),
        onRaw: (kind, text) => {
          if (kind === "stdout") chunks.push(text);
        },
      })) {
        if (event.type === "error") errors.push(String(event.message));
        if (event.sessionId)
          this.content.db
            .prepare("UPDATE agent_runs SET session_id=? WHERE id=?")
            .run(event.sessionId, runId);
        if (event.final) {
          completed = !!event.completed && event.exitCode === 0;
          result = event.structuredOutput;
          this.content.db
            .prepare("UPDATE agent_runs SET cost_usd=?,exit_code=? WHERE id=?")
            .run(event.costUsd ?? null, event.exitCode ?? null, runId);
        }
      }
    } finally {
      await fs.writeFile(logPath, chunks.join(""), { mode: 0o600 });
    }
    if (signal.aborted) throw Error("Cancelled");
    if (!completed || errors.length)
      throw Error(errors.join("\n") || "Agent did not complete");
    return parseAgentOutput(schema, result) as any;
  }
  async run(
    job: JobView,
    signal: AbortSignal,
    emit: (type: string, data?: Record<string, unknown>) => void,
  ): Promise<unknown> {
    const p = job.payload;
    const store = await this.writable(job.project_id);
    if (p.provider)
      await store.updateProject({
        settings: {
          ...store.project.settings,
          lastAgent: {
            ...store.project.settings.lastAgent,
            [job.type]: p.provider,
          },
        },
      });
    const workspace = path.join(this.content.home, "workspaces", job.id);
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    if (job.type === "image.capture") {
      const input = CaptureInput.parse(p);
      return this.capture(job.project_id, input, signal);
    }
    if (job.type === "image.steps") {
      const output = await this.agent(
        job,
        workspace,
        `TASK: image.steps\nConvert the description to steps JSON. Actions: click,type,scroll,hover,wait,press. Type uses text, press uses value, scroll uses numeric value, wait uses ms. Selectors must be CSS. Do not run any steps. Description: ${p.description}`,
        z.object({ steps: z.array(CaptureStep).max(50) }),
        signal,
      );
      return output;
    }
    if (job.type === "image.alt") {
      const { item, bytes } = await this.assets.get(job.project_id, p.sha);
      const imageFile = path.join(
        workspace,
        "image." +
          (item.mime === "image/jpeg" ? "jpg" : item.mime.split("/")[1]),
      );
      await fs.writeFile(imageFile, bytes, { mode: 0o444 });
      return this.agent(
        job,
        workspace,
        `TASK: image.alt\nRead the local image file in this workspace, then suggest concise alt text grounded in it and user context. Do not invent visual details. Metadata: ${JSON.stringify(item)}. Context: ${p.context || ""}`,
        z.object({ alt: z.string().max(1000) }),
        signal,
      );
    }
    if (job.type !== "image.edit") throw Error("Unknown image task");
    return this.serial(job.project_id + p.compositionId, async () => {
      const snap = await this.snapshot(job.project_id, p.compositionId),
        comp = path.join(workspace, "comp");
      await fs.cp(snap.dir, comp, { recursive: true });
      const sources = await this.sources(job.project_id, snap.config);
      const sourceDir = path.join(workspace, "sources");
      await fs.mkdir(sourceDir);
      for (const [sha, src] of sources) {
        await fs.copyFile(src.file, path.join(sourceDir, sha));
        await fs.chmod(path.join(sourceDir, sha), 0o444);
      }
      const skill = await fs.readFile(
        fileURLToPath(
          new URL(
            "../../../../agent-skills/image-composer.md",
            import.meta.url,
          ),
        ),
        "utf8",
      );
      await fs.writeFile(path.join(workspace, "image-composer.md"), skill);
      emit("progress", { message: "Editing image in isolated workspace" });
      await this.agent(
        job,
        comp,
        `${skill}\nTASK: image.edit\nInstruction: ${p.instruction}\nEdit files in this composition directory. Read-only source copies are in ../sources. Return {"done":true} when finished.`,
        z.object({ done: z.boolean() }),
        signal,
        true,
      );
      const errors = await validateComposition(comp);
      if (errors.length) throw Error(errors.join("\n"));
      const next = Composition.parse(
        JSON.parse(
          await fs.readFile(path.join(comp, "composition.json"), "utf8"),
        ),
      );
      if (
        next.id !== snap.config.id ||
        JSON.stringify(next.sources) !== JSON.stringify(snap.config.sources) ||
        next.allowScreenshotEdits !== snap.config.allowScreenshotEdits
      )
        throw Error("Agent changed protected composition metadata");
      // Check immutable originals AND workspace source copies before admitting any edit.
      const { hash } = await import("./assets.js");
      for (const sha of next.sources)
        if (hash(await fs.readFile(path.join(sourceDir, sha))) !== sha)
          throw Error("Source copy hash mismatch");
      const url = await this.origin.mount({ dir: comp, config: next, sources });
      const rendered = await renderAndCheck(url, next, sources);
      if (!rendered.fidelity.pass)
        throw Error(rendered.fidelity.errors.join("\n"));
      if (signal.aborted) throw Error("Cancelled");
      const dir = await this.dir(job.project_id, p.compositionId);
      await this.replace(dir, comp);
      const commit = await this.commit(dir, p.instruction);
      await fs.rm(workspace, { recursive: true, force: true });
      return {
        compositionId: p.compositionId,
        commit,
        fidelity: rendered.fidelity,
      };
    });
  }
  async capture(
    project: string,
    input: z.infer<typeof CaptureInput>,
    signal: AbortSignal,
  ) {
    const [width, height] = input.viewport.split("x").map(Number),
      b = await chromium.launch({ chromiumSandbox: false });
    const abort = () => void b.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const context = await b.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(input.url, { waitUntil: "load", timeout: 30000 });
      for (const step of input.steps) {
        if (signal.aborted) throw Error("Cancelled");
        const locator = step.selector ? page.locator(step.selector) : undefined;
        switch (step.action) {
          case "click":
            await locator!.click();
            break;
          case "type":
            await locator!.fill(step.text!);
            break;
          case "hover":
            await locator!.hover();
            break;
          case "wait":
            await page.waitForTimeout(step.ms ?? 1000);
            break;
          case "press":
            if (locator) await locator.press(String(step.value));
            else await page.keyboard.press(String(step.value));
            break;
          case "scroll":
            if (locator)
              await locator.evaluate(
                (e, v) => e.scrollBy(0, v),
                Number(step.value ?? 500),
              );
            else
              await page.evaluate(
                (v) => window.scrollBy(0, v),
                Number(step.value ?? 500),
              );
            break;
        }
      }
      if (input.waitFor === "networkidle")
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      else if (input.waitFor === "selector") {
        if (!input.waitSelector) throw Error("Wait selector is required");
        await page.locator(input.waitSelector).waitFor();
      } else await page.waitForTimeout(input.delay);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map((i) => i.decode().catch(() => {})),
        );
      });
      const bytes = input.selector
        ? await page
            .locator(input.selector)
            .screenshot({ animations: "disabled" })
        : await page.screenshot({
            fullPage: input.fullPage,
            animations: "disabled",
          });
      if (signal.aborted) throw Error("Cancelled");
      return this.assets.put(project, bytes, "screenshot", {
        type: "capture",
        url: input.url,
        steps: input.steps,
        viewport: { width, height, dpr: 2 },
      });
    } finally {
      signal.removeEventListener("abort", abort);
      await b.close();
    }
  }
}
