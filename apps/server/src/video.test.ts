import { it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import {
  CaptureStep,
  VideoCaptureInput,
  VideoComposition,
  VideoCaption,
  VideoScene,
} from "@bip/shared";
import {
  captureQuality,
  zoomState,
  speedRamp,
  outputTime,
  sourceTime,
  diffSize,
} from "./video/model.js";
import { validateVideo } from "./video/validate.js";
import { Hono } from "hono";
import { videoRoutes } from "./video/routes.js";
import type { VideoStudio } from "./video/studio.js";
import { createApp } from "./app.js";
import { git } from "./git.js";
import { probe, command } from "./video/process.js";
it("validates pause, smooth scroll, approval, scenes and captions", () => {
  for (const s of [
    { action: "pause", ms: 100 },
    { action: "scrollTo", selector: "#x", durationMs: 900 },
    { action: "scrollTo", y: 200, durationMs: 800 },
  ])
    expect(CaptureStep.safeParse(s).success).toBe(true);
  for (const s of [
    { action: "pause" },
    { action: "pause", ms: 30001 },
    { action: "scrollTo", y: 1 },
    { action: "scrollTo", durationMs: 1 },
    { action: "scroll", value: "bad" },
  ])
    expect(CaptureStep.safeParse(s).success).toBe(false);
  expect(
    VideoCaptureInput.safeParse({
      url: "https://example.com",
      steps: [],
      approved: false,
    }).success,
  ).toBe(false);
  expect(
    VideoCaption.safeParse({ text: "x", startMs: 100, endMs: 90 }).success,
  ).toBe(false);
  expect(
    VideoScene.safeParse({
      id: "x",
      kind: "other",
      startMs: 0,
      endMs: 100,
      notes: "",
    }).success,
  ).toBe(false);
  expect(VideoComposition.safeParse({}).success).toBe(false);
  expect(CaptureStep.safeParse({ action: "wait" }).success).toBe(true);
  expect(
    CaptureStep.safeParse({ action: "scroll", value: "500" }).success,
  ).toBe(true);
});
it("accepts caption slot patches at the HTTP boundary and rejects protected fields", async () => {
  const app = new Hono(),
    update = vi.fn(async () => ({ saved: true }));
  videoRoutes(app, { update } as unknown as VideoStudio);
  const captions = [{ text: "Updated caption", startMs: 0, endMs: 1000 }],
    url = "http://localhost/api/projects/p/video/compositions/c";
  const response = await app.request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ captions }),
  });
  expect(response.status).toBe(200);
  expect(update).toHaveBeenCalledWith("p", "c", { captions });
  app.onError((e, c) => c.json({ error: e.message }, 400));
  const invalid = await app.request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sources: ["a".repeat(64)] }),
  });
  expect(invalid.status).toBe(400);
  expect(update).toHaveBeenCalledTimes(1);
});
it("measures effective delivery fps and boundary gaps without claiming duplicated frames as delivered", () => {
  expect(
    captureQuality(
      Array.from({ length: 30 }, (_, i) => (i * 1000) / 30),
      1000,
    ),
  ).toMatchObject({ effectiveFps: 30, choppy: false });
  expect(captureQuality([0, 600, 700, 900], 1000)).toMatchObject({
    effectiveFps: 4,
    maxGapMs: 600,
    choppy: true,
  });
  expect(
    captureQuality(
      Array.from({ length: 30 }, (_, i) => i * 10),
      1000,
    ),
  ).toMatchObject({ effectiveFps: 30, maxGapMs: 710, choppy: true });
  expect(
    captureQuality(
      Array.from({ length: 11 }, (_, i) => i * 90),
      1000,
    ),
  ).toMatchObject({ effectiveFps: 11, maxGapMs: 100, choppy: true });
  expect(captureQuality([], 1000)).toMatchObject({
    effectiveFps: 0,
    maxGapMs: 1000,
    choppy: true,
  });
  expect(
    captureQuality(
      Array.from({ length: 12 }, (_, i) => (i * 1000) / 12),
      1000,
    ).choppy,
  ).toBe(false);
});
it("ports measured zoom preroll/hold/ease, centres both axes, clamps edges, and selects the longest scroll", () => {
  const c = { type: "click", t: 1, x: 800, y: 400 };
  expect(zoomState(0.6, [c], 1440, 900).z).toBe(1);
  expect(zoomState(0.8, [c], 1440, 900).z).toBeCloseTo(1.3);
  const full = zoomState(1.2, [c], 1440, 900);
  expect(full.z).toBe(1.6);
  expect(800 * full.z + full.tx).toBe(720);
  expect(400 * full.z + full.ty).toBe(450);
  expect(zoomState(1.675, [c], 1440, 900).z).toBeCloseTo(1.3);
  expect(zoomState(2, [c], 1440, 900).z).toBe(1);
  expect(zoomState(1, [{ ...c, x: 0, y: 0 }], 1440, 900)).toMatchObject({
    tx: 0,
    ty: 0,
  });
  expect(zoomState(1, [{ ...c, x: 1440, y: 900 }], 1440, 900).ty).toBeCloseTo(
    -540,
  );
  const r = speedRamp(
    [0, 0.1, 1, 1.2, 1.4, 1.6].map((t) => ({ type: "scroll", t, x: 0, y: 0 })),
  );
  expect(r).toEqual({ start: 1, end: 1.6, rate: 2 });
  expect(outputTime(2, r)).toBeCloseTo(1.7);
  expect(sourceTime(outputTime(1.3, r), r)).toBeCloseTo(1.3);
  expect(diffSize("101\t100\tindex.html", "Shorten intro").largeChange).toBe(
    true,
  );
  expect(diffSize("2\t1\tcomposition.json", "Shorten intro").largeChange).toBe(
    false,
  );
  expect(
    diffSize(
      ["a", "b", "c", "d"].map((f) => "1\t0\t" + f).join("\n"),
      "Change title",
    ).largeChange,
  ).toBe(true);
});
it("rejects GSAP src, import, global and registry usage, external URLs and disallowed files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bip-video-validator-"));
  try {
    for (const text of [
      '<script src="assets/gsap.min.js"></script>',
      `import gsap from 'gsap'`,
      `window.gsap.to('#x',{})`,
      `window.__timelines={}`,
      `<img src="https://evil.test/x">`,
      `@import '//evil.test/a.css';`,
    ]) {
      await fs.writeFile(path.join(dir, "index.html"), text);
      const errors = await validateVideo(dir, dir, false);
      expect(
        errors.some((s) => /GSAP|External/.test(s)),
        text,
      ).toBe(true);
    }
    await fs.writeFile(path.join(dir, "run.sh"), "echo bad");
    expect((await validateVideo(dir, dir, false)).join()).toContain(
      "Disallowed",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it("captures fixture → events/assets → lint → contact sheet/540p → 3s final, fake-agent revision, restore and cached render", async () => {
  const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "bip-video-integration-"),
    ),
    repo = path.join(root, "repos/demo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await fs.writeFile(path.join(repo, "README.md"), "Demo");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Initial",
  ]);
  const s = createApp({ home: path.join(root, "data"), fsHome: root });
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      '<style>body{height:2000px;background:#263141;color:white}button{margin:200px;padding:40px}b{display:block;animation:p 1s infinite alternate}@keyframes p{to{transform:translateX(50px)}}</style><button id="go" class="cursor-pointer" onclick="this.textContent=\'Shipped\'">Ship</button><b>Demo animation</b>',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const done = async (jobId: string) => {
    await vi.waitFor(
      () =>
        expect(["succeeded", "failed", "cancelled"]).toContain(
          s.content.jobs.get(jobId).status,
        ),
      { timeout: 120000, interval: 200 },
    );
    const job = s.content.jobs.get(jobId);
    expect(job.error).toBeNull();
    return job;
  };
  try {
    await s.projects.scan(path.dirname(repo), 2);
    const [p] = await s.projects.track([repo]);
    const capture = await s.videos.capture(
      p.id,
      VideoCaptureInput.parse({
        url: `http://127.0.0.1:${(server.address() as any).port}`,
        steps: [
          { action: "pause", ms: 1000 },
          { action: "click", selector: "#go" },
          { action: "scrollTo", y: 350, durationMs: 800 },
          { action: "pause", ms: 2100 },
        ],
        approved: true,
      }),
      new AbortController().signal,
    );
    expect(capture.recording.kind).toBe("recording");
    expect(capture.events.kind).toBe("event_log");
    expect(capture.recording.hasAudio).toBe(false);
    expect(capture.recording.durationMs).toBeGreaterThan(3900);
    const log = JSON.parse(
      (await s.videos.assets.get(p.id, capture.events.sha)).bytes.toString(),
    );
    expect(log.events.find((e: any) => e.type === "click").t).toBeGreaterThan(
      0.9,
    );
    expect(log.actions[2].endT).toBeGreaterThan(log.actions[2].t);
    const v = await s.videos.create(p.id, {
      sources: [capture.recording.sha],
      style: "clean",
      durationMs: 3000,
      brief: "A faster capture path. Every click is measured.",
    });
    expect(v.composition.captions.map((c) => c.text)).toEqual([
      "A faster capture path.",
      "Every click is measured.",
    ]);
    const id = v.composition.id;
    const dir = await s.videos.dir(p.id, id);
    expect(await s.videos.validate(p.id, dir)).toEqual([]);
    await done(
      s.content.jobs.list().find((j) => j.type === "video.contact")!.id,
    );
    await done(
      s.content.jobs.list().find((j) => j.type === "video.preview")!.id,
    );
    const next = await s.videos.view(p.id, id),
      rev = next.revisions.at(-1)!;
    expect(rev.contactSha).toBeTruthy();
    expect(rev.previewSha).toBeTruthy();
    const preview = await probe(
      await s.videos.assets.file(p.id, rev.previewSha!),
    );
    expect(preview).toMatchObject({
      width: 960,
      height: 540,
      codec: "h264",
      fps: "30/1",
    });
    const final = await s.videos.render(p.id, id, next.commit, "landscape");
    expect(final).toMatchObject({
      kind: "video_render",
      width: 1920,
      height: 1080,
    });
    expect(final.durationMs).toBeCloseTo(3000, -2);
    const streams = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        await s.videos.assets.file(p.id, final.sha),
      ]),
    );
    expect(streams.streams.some((s: any) => s.codec_name === "aac")).toBe(true);
    expect(
      (await s.videos.render(p.id, id, next.commit, "landscape")).sha,
    ).toBe(final.sha);
    const repeated = await s.videos.render(
      p.id,
      id,
      next.commit,
      "landscape",
      undefined,
      () => {},
      true,
    );
    expect(
      repeated.provenance.type === "render" && repeated.provenance.frameHash,
    ).toBe(final.provenance.type === "render" && final.provenance.frameHash);
    vi.stubEnv("BIP_CODEX_BIN", path.resolve("tests/fixtures/agents/fake.mjs"));
    const edited = await done(
      s.videos.task("video.edit", p.id, {
        compositionId: id,
        provider: "codex",
        instruction: "Shorten the intro by 100 ms",
      }).id,
    );
    expect(edited.result.commit).not.toBe(next.commit);
    await done(
      s.content.jobs
        .list()
        .find(
          (j) =>
            j.type === "video.preview" &&
            j.payload.commit === edited.result.commit,
        )!.id,
    );
    const editedView = await s.videos.view(p.id, id);
    expect(editedView.composition.scenes[0].endMs).toBe(
      v.composition.scenes[0].endMs - 100,
    );
    expect(editedView.revisions.at(-1)?.diffStat).toContain("composition.json");
    const failedJob = s.videos.task("video.edit", p.id, {
      compositionId: id,
      provider: "codex",
      instruction: "VIDEO_GSAP_FAIL",
    });
    await vi.waitFor(
      () => expect(s.content.jobs.get(failedJob.id).status).toBe("failed"),
      { timeout: 20000 },
    );
    expect(s.content.jobs.get(failedJob.id).error).toContain("GSAP");
    expect((await s.videos.view(p.id, id)).commit).toBe(editedView.commit);
    const customFile = path.join(await s.videos.dir(p.id, id), "index.html");
    await fs.writeFile(
      customFile,
      (await fs.readFile(customFile, "utf8")).replace(
        "</main>",
        '<div id="custom-layout" style="display:none">Keep this custom detail</div></main>',
      ),
    );
    await s.images.commit(await s.videos.dir(p.id, id), "Custom HTML fixture");
    const customCaption = await s.videos.update(p.id, id, {
      captions: editedView.composition.captions.map((c, i) =>
        i === 0 ? { ...c, text: "A direct caption <edit>" } : c,
      ),
    });
    const customHtml = await fs.readFile(customFile, "utf8");
    expect(customHtml).toContain('id="custom-layout"');
    expect(customHtml).toContain("A direct caption &lt;edit&gt;");
    const staleCustom = s.videos.task("video.edit", p.id, {
      compositionId: id,
      provider: "codex",
      instruction: "Shorten intro using JSON only",
    });
    await vi.waitFor(
      () => expect(s.content.jobs.get(staleCustom.id).status).toBe("failed"),
      { timeout: 120000 },
    );
    expect(s.content.jobs.get(staleCustom.id).error).toContain(
      "Custom HTML must be updated",
    );
    expect((await s.videos.view(p.id, id)).commit).toBe(customCaption.commit);
    const restored = await s.videos.restore(p.id, id, next.commit);
    expect(restored.composition).toEqual(v.composition);
    const imported = await s.videos.import(
      p.id,
      await fs.readFile(await s.videos.assets.file(p.id, final.sha)),
      "demo.mp4",
    );
    expect(imported.provenance.type).toBe("video_import");
    expect(imported.hasAudio).toBe(true);
    expect(
      (await s.videos.view(p.id, id, next.commit)).revisions.find(
        (r) => r.commit === next.commit,
      )?.finalSha,
    ).toBeTruthy();
    await expect(
      s.videos.import(p.id, Buffer.from("invalid"), "bad.mp4"),
    ).rejects.toThrow();
    const response = await s.app.request(
      `http://127.0.0.1:4310/api/projects/${p.id}/assets/${final.sha}`,
      {
        headers: {
          host: "127.0.0.1:4310",
          cookie: "bip_session=" + s.token,
          range: "bytes=0-31",
        },
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toMatch(/^bytes 0-31\//);
    expect((await response.arrayBuffer()).byteLength).toBe(32);
    const still = await s.videos.still(p.id, capture.recording.sha);
    const technical = await s.videos.create(p.id, {
      sources: [still.sha],
      style: "technical",
      durationMs: 1000,
    });
    expect(technical.composition.scenes.some((s) => s.id === "terminal")).toBe(
      true,
    );
    expect(
      technical.composition.scenes.some(
        (s) => s.id === "annotated" && s.sourceSha === still.sha,
      ),
    ).toBe(true);
    const technicalPreview = s.content.jobs
      .list()
      .find(
        (j) =>
          j.type === "video.preview" &&
          j.payload.compositionId === technical.composition.id,
      )!;
    await done(technicalPreview.id);
    const square = await s.videos.render(
      p.id,
      technical.composition.id,
      technical.commit,
      "square",
    );
    expect(
      await probe(await s.videos.assets.file(p.id, square.sha)),
    ).toMatchObject({ width: 1080, height: 1080, codec: "h264", fps: "30/1" });
    const vertical = await s.videos.render(
      p.id,
      technical.composition.id,
      technical.commit,
      "vertical",
    );
    expect(
      await probe(await s.videos.assets.file(p.id, vertical.sha)),
    ).toMatchObject({ width: 1080, height: 1920, codec: "h264", fps: "30/1" });
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
  } finally {
    await s.close();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 240000);
