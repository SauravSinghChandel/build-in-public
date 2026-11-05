import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CaptureStep,
  VideoCaptureInput,
  VideoComposition,
  type VideoCompositionData,
  type VideoView,
  type VideoRevision,
  type JobView,
  type AssetData,
} from "@bip/shared";
import type { ImageStudio } from "../image/studio.js";
import { safeFile, hash } from "../image/assets.js";
import { atomicJsonWrite } from "../bip/store.js";
import { git } from "../git.js";
import { buildHtml, generatedHtml, patchCaptionHtml } from "./build.js";
import { captureDemo } from "./capture.js";
import { command, hyperframes, probe } from "./process.js";
import { diffSize, outputTime, speedRamp, type EventLog } from "./model.js";
import { renderHtml, validateVideo } from "./validate.js";
const templates = fileURLToPath(
  new URL("../../../../packages/templates/video/", import.meta.url),
);
const skillPath = fileURLToPath(
  new URL("../../../../agent-skills/video-editor.md", import.meta.url),
);
export class VideoStudio {
  readonly assets;
  readonly content;
  private chains = new Map<string, Promise<unknown>>();
  private snapshots = new Map<
    string,
    Promise<{ dir: string; commit: string; config: VideoCompositionData }>
  >();
  constructor(readonly images: ImageStudio) {
    this.assets = images.assets;
    this.content = images.content;
    this.content.videoHandler = (j, s, e) => this.run(j, s, e);
  }
  serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.chains.get(key) || Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.chains.set(key, task);
    return task;
  }
  dir(project: string, id: string) {
    return this.images.dir(project, id);
  }
  async config(project: string, id: string) {
    return VideoComposition.parse(
      JSON.parse(
        await fs.readFile(
          await safeFile(await this.dir(project, id), "composition.json"),
          "utf8",
        ),
      ),
    );
  }
  async logs(project: string, c: VideoCompositionData) {
    const logs = new Map<string, EventLog>(),
      all = await this.assets.list(project);
    for (const sha of c.sources) {
      const item = all.find((a) => a.sha === sha);
      if (!item) throw Error("Source asset missing");
      if (item.provenance.type === "video_capture") {
        const { bytes } = await this.assets.get(
          project,
          item.provenance.eventLogSha,
        );
        logs.set(sha, JSON.parse(bytes.toString()));
      }
    }
    return logs;
  }
  async build(project: string, dir: string, c: VideoCompositionData) {
    const assets = await this.assets.list(project);
    await buildHtml(
      dir,
      c,
      await this.logs(project, c),
      1920,
      1080,
      new Map(
        assets.map((a) => [
          a.sha,
          { width: a.width, height: a.height, hasAudio: a.hasAudio },
        ]),
      ),
    );
  }
  async still(project: string, sha: string) {
    const { item } = await this.assets.get(project, sha);
    if (item.mime.startsWith("image/")) return item;
    const dir = path.join(this.content.home, "video-stills", randomUUID());
    await fs.mkdir(dir, { recursive: true });
    try {
      const timeMs = Math.min(1000, (item.durationMs || 1000) / 2),
        file = path.join(dir, "still.png");
      await command("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-ss",
        String(timeMs / 1000),
        "-i",
        await this.assets.file(project, sha),
        "-frames:v",
        "1",
        file,
      ]);
      return await this.assets.put(
        project,
        await fs.readFile(file),
        "screenshot",
        { type: "video_still", recordingSha: sha, timeMs },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  async validate(project: string, dir: string, signal?: AbortSignal) {
    const errors = await validateVideo(dir, this.content.home, false);
    if (errors.length) return errors;
    const c = VideoComposition.parse(
        JSON.parse(
          await fs.readFile(path.join(dir, "composition.json"), "utf8"),
        ),
      ),
      sources = new Map<string, string>();
    for (const sha of c.sources) {
      const a = await this.assets.get(project, sha);
      if (hash(a.bytes) !== sha) throw Error("Source hash mismatch");
      sources.set(sha, await this.assets.file(project, sha));
    }
    return validateVideo(dir, this.content.home, true, signal, sources);
  }
  async snapshot(project: string, id: string, revision?: string) {
    const dir = await this.dir(project, id),
      revs = await this.images.revisions(dir),
      commit = revision || revs.at(-1)?.commit;
    if (!commit || !revs.some((r) => r.commit === commit))
      throw Error("Unknown video revision");
    const key = project + id + commit,
      existing = this.snapshots.get(key);
    if (existing) return existing;
    const task = (async () => {
      const dest = path.join(
        this.content.home,
        "video-snapshots",
        project,
        id,
        commit,
      );
      await fs.mkdir(dest, { recursive: true });
      const { execFile } = await import("node:child_process");
      for (const name of (
        await git(dir, ["ls-tree", "-r", "--name-only", commit])
      )
        .trim()
        .split("\n")) {
        if (
          ![
            "composition.json",
            "index.html",
            "styles.css",
            "motion.js",
          ].includes(name)
        )
          throw Error("Disallowed revision file");
        const bytes = await new Promise<Buffer>((r, j) =>
          execFile(
            "git",
            ["show", `${commit}:${name}`],
            { cwd: dir, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 + 1 },
            (e, b) => (e ? j(e) : r(b)),
          ),
        );
        await fs.writeFile(await safeFile(dest, name), bytes);
      }
      return {
        dir: dest,
        commit,
        config: VideoComposition.parse(
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
  async view(
    project: string,
    id: string,
    revision?: string,
  ): Promise<VideoView> {
    const snap = await this.snapshot(project, id, revision),
      all = await this.assets.list(project),
      revs = await this.images.revisions(await this.dir(project, id));
    const revisions: VideoRevision[] = [];
    for (const [i, r] of revs.entries()) {
      const stat = i
        ? await git(await this.dir(project, id), [
            "diff",
            "--stat",
            revs[i - 1].commit,
            r.commit,
          ])
        : "Initial composition";
      const num = i
        ? await git(await this.dir(project, id), [
            "diff",
            "--numstat",
            revs[i - 1].commit,
            r.commit,
          ])
        : "";
      const renders = all.filter(
        (a) =>
          a.provenance.type === "render" &&
          a.provenance.compositionId === id &&
          a.provenance.commit === r.commit,
      );
      const find = (variant: string) =>
        renders.find(
          (a) =>
            a.provenance.type === "render" && a.provenance.variant === variant,
        )?.sha;
      revisions.push({
        ...r,
        diffStat: stat,
        largeChange: diffSize(num, r.instruction).largeChange,
        contactSha: find("contact"),
        previewSha: find("preview"),
        finalSha: find("landscape"),
        squareSha: find("square"),
        verticalSha: find("vertical"),
      });
    }
    const logs = await this.logs(project, snap.config),
      clicks = [];
    for (const s of snap.config.scenes) {
      const log = logs.get(s.sourceSha!);
      if (s.kind === "recording" && log)
        for (const e of log.events.filter((e) => e.type === "click"))
          clicks.push({
            ...e,
            t: s.startMs / 1000 + outputTime(e.t, speedRamp(log.events)),
          });
    }
    return {
      composition: snap.config,
      commit: snap.commit,
      revisions,
      clicks,
      choppy: all.some(
        (a) => snap.config.sources.includes(a.sha) && a.quality?.choppy,
      ),
    };
  }
  async list(project: string) {
    const store = await this.content.projects.store(project),
      dir = await safeFile(store.root, "compositions"),
      rows = [];
    for (const id of await fs.readdir(dir).catch(() => [])) {
      const c = JSON.parse(
        await fs.readFile(
          await safeFile(dir, id + "/composition.json"),
          "utf8",
        ),
      );
      if (c.type === "video") rows.push(await this.view(project, id));
    }
    return rows;
  }
  task(type: string, project: string, payload: Record<string, unknown>) {
    return this.content.jobs.enqueue(
      type,
      project,
      `${project}:video:${payload.compositionId || "capture"}`,
      payload,
    );
  }
  reviews(project: string, id: string, commit: string) {
    this.task("video.contact", project, { compositionId: id, commit });
    this.task("video.preview", project, { compositionId: id, commit });
  }
  async save(
    project: string,
    c: VideoCompositionData,
    dir: string,
    instruction: string,
  ) {
    VideoComposition.parse(c);
    await atomicJsonWrite(path.join(dir, "composition.json"), c);
    await this.build(project, dir, c);
    const errors = await this.validate(project, dir);
    if (errors.length) throw Error(errors.join("\n"));
    const commit = await this.images.commit(dir, instruction);
    this.reviews(project, c.id, commit);
    return this.view(project, c.id);
  }
  async create(
    project: string,
    input: {
      sources: string[];
      style: "clean" | "technical";
      storyId?: string;
      brief?: string;
      durationMs?: number;
    },
  ) {
    const store = await this.images.writable(project);
    if (input.storyId) await store.readStory(input.storyId);
    const sources = [];
    for (const sha of input.sources) {
      const { item } = await this.assets.get(project, sha);
      if (
        !["recording", "image_render", "screenshot", "upload"].includes(
          item.kind,
        )
      )
        throw Error("Choose recordings or images");
      sources.push(item);
    }
    if (!sources.length) throw Error("Choose a source");
    const id = randomUUID(),
      dir = await this.dir(project, id);
    await fs.mkdir(dir, { recursive: true });
    let admitted = false;
    try {
      await fs.copyFile(
        path.join(templates, input.style, "styles.css"),
        path.join(dir, "styles.css"),
      );
      const scenes: VideoCompositionData["scenes"] = [],
        captions: VideoCompositionData["captions"] = [];
      let at = 1000;
      scenes.push({
        id: "intro",
        kind: "title",
        startMs: 0,
        endMs: at,
        notes: input.brief?.slice(0, 100) || "A detail worth sharing",
      });
      for (const [i, source] of sources.entries()) {
        const logs = await this.logs(project, {
            sources: [source.sha],
          } as VideoCompositionData),
          log = logs.get(source.sha);
        const duration =
          source.kind === "recording"
            ? log
              ? outputTime(log.duration, speedRamp(log.events)) * 1000
              : source.durationMs!
            : 3000;
        scenes.push({
          id: `scene-${i}`,
          kind: source.kind === "recording" ? "recording" : "still",
          startMs: at,
          endMs: at + duration,
          sourceSha: source.sha,
          notes: input.brief?.slice(0, 300) || "The detail that matters",
        });
        at += duration;
      }
      if (input.style === "technical") {
        scenes.push({
          id: "terminal",
          kind: "still",
          startMs: at,
          endMs: at + 1500,
          notes: "The implementation, tested locally",
        });
        at += 1500;
        const still = await this.still(project, input.sources[0]);
        if (!input.sources.includes(still.sha))
          input = { ...input, sources: [...input.sources, still.sha] };
        scenes.push({
          id: "annotated",
          kind: "still",
          startMs: at,
          endMs: at + 1500,
          sourceSha: still.sha,
          notes: "The useful detail, up close",
        });
        at += 1500;
      }
      scenes.push({
        id: "outro",
        kind: "outro",
        startMs: at,
        endMs: at + 1000,
        notes: "Built. Tested. Shared.",
      });
      at += 1000;
      const target = input.durationMs || at,
        ratio = target / at;
      for (const s of scenes) {
        s.startMs = Math.round(s.startMs * ratio);
        s.endMs = Math.min(target, Math.round(s.endMs * ratio));
      }
      captions.push(
        {
          text: input.brief?.slice(0, 200) || "A closer look at the workflow",
          startMs: scenes[1].startMs,
          endMs: scenes[1].startMs + (scenes[1].endMs - scenes[1].startMs) / 2,
        },
        {
          text: "Small details make the difference",
          startMs:
            scenes[1].startMs + (scenes[1].endMs - scenes[1].startMs) / 2,
          endMs: scenes[1].endMs,
        },
      );
      for (const scene of scenes.slice(2, sources.length + 1))
        if (scene.kind === "still")
          captions.push({
            text: scene.notes,
            startMs: scene.startMs,
            endMs: scene.endMs,
          });
      const c = VideoComposition.parse({
        schemaVersion: 1,
        id,
        type: "video",
        title: "Untitled video",
        fps: 30,
        durationMs: target,
        style: input.style,
        sources: input.sources,
        storyId: input.storyId,
        scenes,
        captions,
      });
      await git(dir, ["init", "-b", "main"]);
      const v = await this.save(
        project,
        c,
        dir,
        "Create " + input.style + " video",
      );
      admitted = true;
      if (input.storyId) {
        const story = await store.readStory(input.storyId);
        await store.updateStory(story.id, {
          compositionIds: [...story.compositionIds, id],
        });
      }
      return v;
    } catch (e) {
      if (!admitted) await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async update(
    project: string,
    id: string,
    patch: Partial<VideoCompositionData>,
  ) {
    return this.serial(project + id, async () => {
      await this.images.writable(project);
      const old = await this.config(project, id),
        next = VideoComposition.parse({
          ...old,
          ...patch,
          id,
          type: "video",
          sources: old.sources,
          storyId: old.storyId,
        });
      if (
        next.style === "technical" &&
        old.style !== "technical" &&
        !next.scenes.some((s) => s.id === "terminal")
      ) {
        const still = await this.still(project, next.sources[0]),
          at =
            next.scenes.find((s) => s.kind === "outro")?.startMs ??
            next.durationMs;
        for (const s of next.scenes)
          if (s.startMs >= at) {
            s.startMs += 3000;
            s.endMs += 3000;
          }
        for (const c of next.captions)
          if (c.startMs >= at) {
            c.startMs += 3000;
            c.endMs += 3000;
          }
        next.scenes.push(
          {
            id: "terminal",
            kind: "still",
            startMs: at,
            endMs: at + 1500,
            notes: "The implementation, tested locally",
          },
          {
            id: "annotated",
            kind: "still",
            startMs: at + 1500,
            endMs: at + 3000,
            sourceSha: still.sha,
            notes: "The useful detail, up close",
          },
        );
        next.scenes.sort((a, b) => a.startMs - b.startMs);
        next.durationMs += 3000;
        if (!next.sources.includes(still.sha)) next.sources.push(still.sha);
      }
      const workspace = path.join(
        this.content.home,
        "video-edits",
        randomUUID(),
      );
      await fs.mkdir(workspace, { recursive: true });
      try {
        const snap = await this.snapshot(project, id);
        await fs.cp(snap.dir, workspace, { recursive: true });
        if (next.style !== old.style)
          await fs.copyFile(
            path.join(templates, next.style, "styles.css"),
            path.join(workspace, "styles.css"),
          );
        await atomicJsonWrite(path.join(workspace, "composition.json"), next);
        const priorHtml = await fs.readFile(
          path.join(workspace, "index.html"),
          "utf8",
        );
        if (
          patch.captions &&
          next.style === old.style &&
          !generatedHtml(priorHtml)
        ) {
          if (next.captions.length !== old.captions.length)
            throw Error(
              "Use an agent edit to add or remove custom caption slots",
            );
          await fs.writeFile(
            path.join(workspace, "index.html"),
            patchCaptionHtml(priorHtml, next.captions),
          );
        } else await this.build(project, workspace, next);
        const errors = await this.validate(project, workspace);
        if (errors.length) throw Error(errors.join("\n"));
        await this.replace(await this.dir(project, id), workspace);
        const commit = await this.images.commit(
          await this.dir(project, id),
          "Edit video slots",
        );
        this.reviews(project, id, commit);
        return this.view(project, id);
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });
  }
  async replace(dest: string, source: string) {
    for (const name of await fs.readdir(dest))
      if (name !== ".git")
        await fs.rm(await safeFile(dest, name), {
          recursive: true,
          force: true,
        });
    for (const name of (await fs.readdir(source)).filter((n) => n !== ".git"))
      await fs.copyFile(
        await safeFile(source, name),
        await safeFile(dest, name),
      );
  }
  async restore(project: string, id: string, commit: string) {
    return this.serial(project + id, async () => {
      await this.images.writable(project);
      const snap = await this.snapshot(project, id, commit),
        errors = await this.validate(project, snap.dir);
      if (errors.length) throw Error(errors.join("\n"));
      const dir = await this.dir(project, id);
      await this.replace(dir, snap.dir);
      const head = await this.images.commit(dir, "Restore " + commit);
      this.reviews(project, id, head);
      return this.view(project, id);
    });
  }
  async ingest(
    project: string,
    file: string,
    kind: "recording" | "video_render",
    provenance: AssetData["provenance"],
    quality?: AssetData["quality"],
  ) {
    const p = await probe(file);
    if (!/(mp4|mov|webm)/.test(p.format))
      throw Error("Upload MP4, MOV or WebM");
    const stat = await fs.stat(file);
    if (stat.size > 500 * 1024 * 1024)
      throw Error("Video must be at most 500 MB");
    return this.assets.put(project, await fs.readFile(file), kind, provenance, {
      mime: p.mime,
      width: p.width,
      height: p.height,
      durationMs: p.durationMs,
      hasAudio: p.hasAudio,
      quality,
    });
  }
  async jsonAsset(
    project: string,
    data: unknown,
    filename: "events.json" | "scenes.json",
  ) {
    return this.assets.put(
      project,
      Buffer.from(JSON.stringify(data, null, 2)),
      filename === "events.json" ? "event_log" : "scene_log",
      { type: "recording_log", filename },
      { mime: "application/json", width: 1, height: 1 },
    );
  }
  async capture(
    project: string,
    input: z.infer<typeof VideoCaptureInput>,
    signal: AbortSignal,
  ) {
    await this.images.writable(project);
    const dir = path.join(this.content.home, "video-captures", randomUUID());
    try {
      const r = await captureDemo(input, dir, signal),
        events = await this.jsonAsset(project, r.log, "events.json"),
        recording = await this.ingest(
          project,
          r.file,
          "recording",
          {
            type: "video_capture",
            url: input.url,
            steps: input.steps,
            eventLogSha: events.sha,
          },
          r.quality,
        );
      return { recording, events };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  async import(project: string, bytes: Buffer, filename: string) {
    await this.images.writable(project);
    if (
      bytes.length > 500 * 1024 * 1024 ||
      !/^.+\.(mp4|mov|webm)$/i.test(filename)
    )
      throw Error("Upload MP4, MOV or WebM, at most 500 MB");
    const dir = path.join(this.content.home, "video-imports", randomUUID());
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "source");
    try {
      await fs.writeFile(file, bytes);
      const p = await probe(file);
      const raw = await command("ffmpeg", [
        "-hide_banner",
        "-i",
        file,
        "-vf",
        "select='gt(scene,0.3)',showinfo",
        "-an",
        "-f",
        "null",
        "-",
      ]);
      const times = [...raw.matchAll(/pts_time:([\d.]+)/g)].map((m) =>
        Number(m[1]),
      );
      const scenes = await this.jsonAsset(
        project,
        {
          durationMs: p.durationMs,
          scenes: [0, ...times].map((t, i, a) => ({
            startMs: t * 1000,
            endMs: (a[i + 1] ?? p.durationMs / 1000) * 1000,
          })),
        },
        "scenes.json",
      );
      return await this.ingest(project, file, "recording", {
        type: "video_import",
        filename,
        scenesSha: scenes.sha,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  async render(
    project: string,
    id: string,
    commit: string,
    variant: "contact" | "preview" | "landscape" | "square" | "vertical",
    signal?: AbortSignal,
    emit: (type: string, data?: Record<string, unknown>) => void = () => {},
    force = false,
  ) {
    return this.serial("video-render", async () => {
      await this.images.writable(project);
      const snap = await this.snapshot(project, id, commit);
      const cached = (await this.assets.list(project)).find(
        (a) =>
          a.provenance.type === "render" &&
          a.provenance.compositionId === id &&
          a.provenance.commit === commit &&
          a.provenance.variant === variant,
      );
      if (cached && !force) return cached;
      const errors = await this.validate(project, snap.dir);
      if (errors.length) throw Error(errors.join("\n"));
      emit("progress", { message: "Lint passed" });
      const dir = path.join(this.content.home, "video-renders", randomUUID());
      await fs.mkdir(dir, { recursive: true });
      await fs.cp(snap.dir, dir, { recursive: true });
      try {
        const assets = path.join(dir, "assets");
        await fs.mkdir(assets);
        for (const sha of snap.config.sources) {
          const src = await this.assets.get(project, sha);
          if (hash(src.bytes) !== sha) throw Error("Source hash mismatch");
          await fs.writeFile(path.join(assets, sha), src.bytes);
        }
        const size =
          variant === "preview"
            ? [960, 540]
            : variant === "square"
              ? [1080, 1080]
              : variant === "vertical"
                ? [1080, 1920]
                : [1920, 1080];
        const html = await fs.readFile(path.join(dir, "index.html"), "utf8");
        await fs.writeFile(
          path.join(dir, "index.html"),
          renderHtml(html)
            .replace(/data-width="\d+"/, `data-width="${size[0]}"`)
            .replace(/data-height="\d+"/, `data-height="${size[1]}"`),
        );
        if (variant === "contact") {
          const out = path.join(dir, "snapshots"),
            times = Array.from({ length: 12 }, (_, i) =>
              (((snap.config.durationMs - 34) * i) / 11 / 1000).toFixed(3),
            );
          await hyperframes(
            [
              "snapshot",
              "--no-browser-gpu",
              "--at",
              times.join(","),
              "--no-end",
              "--output",
              out,
              "--json",
            ],
            dir,
            this.content.home,
            signal,
          );
          const frames = (await fs.readdir(out))
            .filter((n) => n.endsWith(".png") && !/sheet|contact/i.test(n))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          if (!frames.length)
            throw Error("HyperFrames snapshot produced no frames");
          const tileDir = path.join(dir, "tiles");
          await fs.mkdir(tileDir);
          for (const [i, name] of frames.entries())
            await fs.copyFile(
              path.join(out, name),
              path.join(tileDir, `${String(i).padStart(3, "0")}.png`),
            );
          const file = path.join(dir, "contact.png");
          await command(
            "ffmpeg",
            [
              "-v",
              "error",
              "-y",
              "-i",
              path.join(tileDir, "%03d.png"),
              "-vf",
              "scale=320:180,tile=4x3",
              "-frames:v",
              "1",
              file,
            ],
            { signal },
          );
          return this.assets.put(
            project,
            await fs.readFile(file),
            "contact_sheet",
            { type: "render", compositionId: id, commit, variant },
          );
        }
        const raw = path.join(dir, "raw.mp4");
        emit("progress", { message: "Rendering 0%" });
        await hyperframes(
          [
            "render",
            "--fps",
            "30",
            "--workers",
            "2",
            "--crf",
            variant === "preview" ? "30" : "20",
            "--video-frame-format",
            "png",
            "--no-browser-gpu",
            "-o",
            raw,
          ],
          dir,
          this.content.home,
          signal,
          (s) => {
            const match = s.match(/(\d+(?:\.\d+)?)%/);
            if (match) emit("progress", { message: `Rendering ${match[1]}%` });
          },
        );
        const output = path.join(dir, "video.mp4"),
          rawProbe = await probe(raw);
        await command(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-i",
            raw,
            ...(rawProbe.hasAudio
              ? []
              : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
            "-map",
            "0:v:0",
            "-map",
            rawProbe.hasAudio ? "0:a:0" : "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            output,
          ],
          { signal },
        );
        const p = await probe(output),
          frame = Math.min(
            150,
            Math.max(0, Math.floor((p.durationMs / 1000) * 30) - 1),
          );
        const frameHash = (
          await command(
            "ffmpeg",
            [
              "-v",
              "error",
              "-i",
              output,
              "-vf",
              `select=eq(n\\,${frame})`,
              "-frames:v",
              "1",
              "-f",
              "md5",
              "-",
            ],
            { signal },
          )
        ).trim();
        if (
          cached?.provenance.type === "render" &&
          cached.provenance.frameHash &&
          cached.provenance.frameHash !== frameHash
        ) {
          console.warn("Video determinism warning", id, commit, variant);
          emit("progress", {
            message: "Warning: decoded frame hash differs for the same commit",
          });
        }
        const asset = await this.ingest(project, output, "video_render", {
          type: "render",
          compositionId: id,
          commit,
          variant,
          frameHash,
          hashFrame: frame,
        });
        const store = await this.content.projects.store(project),
          target = await safeFile(
            store.root,
            `renders/${id}/${commit}-${variant}.mp4`,
          );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(output, target);
        return asset;
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
  async run(
    job: JobView,
    signal: AbortSignal,
    emit: (type: string, data?: Record<string, unknown>) => void,
  ): Promise<unknown> {
    const p = job.payload,
      project = job.project_id;
    const store = await this.images.writable(project);
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
    if (job.type === "video.capture") {
      const capture = await this.capture(
        project,
        VideoCaptureInput.parse(p),
        signal,
      );
      const v = await this.create(project, {
        sources: [capture.recording.sha],
        style: "clean",
        storyId: p.storyId,
      });
      return { ...capture, compositionId: v.composition.id };
    }
    if (["video.preview", "video.contact", "video.final"].includes(job.type))
      return this.render(
        project,
        p.compositionId,
        p.commit,
        job.type === "video.preview"
          ? "preview"
          : job.type === "video.contact"
            ? "contact"
            : p.variant || "landscape",
        signal,
        emit,
        p.force === true,
      );
    const workspace = path.join(this.content.home, "workspaces", job.id);
    await fs.mkdir(workspace, { recursive: true });
    try {
      if (job.type === "video.steps")
        return await this.images.agent(
          job,
          workspace,
          `TASK: video.steps\nReturn steps JSON only; never execute. Actions click/type/hover need selector. type needs text, scroll needs numeric value, press needs string value, pause/wait need ms (0..30000), scrollTo needs selector or numeric y plus durationMs. Description: ${p.description}`,
          z.object({ steps: z.array(CaptureStep).max(50) }),
          signal,
        );
      if (job.type !== "video.edit") throw Error("Unknown video job");
      return await this.serial(project + p.compositionId, async () => {
        const snap = await this.snapshot(project, p.compositionId),
          comp = path.join(workspace, "comp");
        await fs.cp(snap.dir, comp, { recursive: true });
        const priorHtml = await fs.readFile(
            path.join(comp, "index.html"),
            "utf8",
          ),
          customMarkup = !generatedHtml(priorHtml);
        const sourceDir = path.join(workspace, "sources");
        await fs.mkdir(sourceDir);
        for (const sha of snap.config.sources) {
          const src = await this.assets.get(project, sha);
          await fs.writeFile(path.join(sourceDir, sha), src.bytes, {
            mode: 0o444,
          });
        }
        let sheet = (await this.assets.list(project)).find(
          (a) =>
            a.kind === "contact_sheet" &&
            a.provenance.type === "render" &&
            a.provenance.compositionId === p.compositionId &&
            a.provenance.commit === snap.commit,
        );
        if (!sheet)
          sheet = await this.render(
            project,
            p.compositionId,
            snap.commit,
            "contact",
            signal,
            emit,
          );
        const image = sheet
          ? path.join(workspace, "contact-sheet.png")
          : undefined;
        if (sheet)
          await fs.copyFile(await this.assets.file(project, sheet.sha), image!);
        const logs = await this.logs(project, snap.config),
          summary = [...logs.entries()].map(([sha, l]) => ({
            sha,
            viewport: l.viewport,
            clicks: l.events.filter((e) => e.type === "click"),
          }));
        const skill = await fs.readFile(skillPath, "utf8");
        emit("progress", { message: "Editing video in isolated workspace" });
        await this.images.agent(
          job,
          comp,
          `${skill}\nTASK: video.edit\nInstruction: ${p.instruction}\ncomposition.json: ${JSON.stringify(snap.config)}\nMeasured events: ${JSON.stringify(summary)}\n${image ? `Read the contact sheet with the Read tool: ${image}` : "Contact sheet not ready."}\nRead-only sources: ../sources. Edit only what was asked. ${customMarkup ? "This revision has custom HTML. Update its existing timing/text together with composition.json. BIP will never regenerate custom markup; preserve every unrelated detail." : "BIP regenerates canonical index.html for JSON-only edits. If you edit HTML too, keep its timing consistent with the JSON."} Return {"done":true}.`,
          z.object({ done: z.boolean() }),
          signal,
          true,
          image ? [image] : [],
        );
        let errors = await validateVideo(comp, this.content.home, false);
        if (errors.length) throw Error(errors.join("\n"));
        const next = VideoComposition.parse(
          JSON.parse(
            await fs.readFile(path.join(comp, "composition.json"), "utf8"),
          ),
        );
        if (
          next.id !== snap.config.id ||
          JSON.stringify(next.sources) !==
            JSON.stringify(snap.config.sources) ||
          next.storyId !== snap.config.storyId
        )
          throw Error("Agent changed protected metadata");
        for (const sha of next.sources) {
          if (
            hash(await fs.readFile(path.join(sourceDir, sha))) !== sha ||
            hash((await this.assets.get(project, sha)).bytes) !== sha
          )
            throw Error("Source hash mismatch");
        }
        if (JSON.stringify(next) !== JSON.stringify(snap.config)) {
          const htmlChanged =
            (await fs.readFile(path.join(comp, "index.html"), "utf8")) !==
            priorHtml;
          if (!htmlChanged && customMarkup)
            throw Error(
              "Custom HTML must be updated together with composition.json; refusing to overwrite its layout",
            );
          if (!htmlChanged) await this.build(project, comp, next);
        }
        errors = await this.validate(project, comp, signal);
        if (errors.length) throw Error(errors.join("\n"));
        signal.throwIfAborted();
        const dir = await this.dir(project, next.id);
        await this.replace(dir, comp);
        const commit = await this.images.commit(dir, p.instruction);
        this.reviews(project, next.id, commit);
        return { compositionId: next.id, commit };
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}
