import type { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { Composition, ImagePreset, ImageSize, CaptureInput } from "@bip/shared";
import { ImageStudio } from "./studio.js";
export function imageRoutes(app: Hono, studio: ImageStudio) {
  const base = "/api/projects/:id",
    comps = base + "/compositions",
    comp = comps + "/:compositionId";
  const agent = z.enum(["claude", "codex"]);
  const sha = z.string().regex(/^[a-f0-9]{64}$/);
  app.use(
    base + "/assets",
    bodyLimit({
      maxSize: 20 * 1024 * 1024 + 65536,
      onError: (c) =>
        c.json({ error: { message: "Images must be at most 20 MB" } }, 413),
    }),
  );
  app.get(base + "/assets", async (c) =>
    c.json(await studio.assets.list(c.req.param("id")!)),
  );
  app.post(base + "/assets", async (c) => {
    const limit = 20 * 1024 * 1024;
    if (Number(c.req.header("content-length")) > limit + 65536)
      throw Error("Images must be at most 20 MB");
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw Error("Choose an image file");
    if (file.size > limit) throw Error("Images must be at most 20 MB");
    return c.json(
      await studio.assets.put(
        c.req.param("id")!,
        Buffer.from(await file.arrayBuffer()),
        "upload",
        { type: "upload", filename: file.name },
      ),
    );
  });
  app.get(base + "/assets/:sha", async (c) => {
    const { item, bytes } = await studio.assets.get(
      c.req.param("id")!,
      sha.parse(c.req.param("sha")),
    );
    c.header("Content-Type", item.mime);
    if (c.req.query("download") === "1")
      c.header(
        "Content-Disposition",
        `attachment; filename="${item.sha}.${item.mime === "image/jpeg" ? "jpg" : item.mime.split("/")[1]}"`,
      );
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(bytes));
  });
  app.get(base + "/assets/:sha/thumbnail", async (c) => {
    c.header("Content-Type", "image/png");
    return c.body(
      new Uint8Array(
        await studio.assets.thumbnail(
          c.req.param("id")!,
          sha.parse(c.req.param("sha")),
        ),
      ),
    );
  });
  app.post(base + "/capture", async (c) =>
    c.json(
      studio.task(
        "image.capture",
        c.req.param("id")!,
        CaptureInput.parse(await c.req.json()),
      ),
    ),
  );
  app.post(base + "/capture/describe", async (c) => {
    const b = z
      .strictObject({
        provider: agent,
        description: z.string().min(1).max(10000),
      })
      .parse(await c.req.json());
    return c.json(studio.task("image.steps", c.req.param("id")!, b));
  });
  app.get(comps, async (c) => c.json(await studio.list(c.req.param("id")!)));
  app.post(comps, async (c) => {
    const b = z
      .strictObject({
        preset: ImagePreset,
        sources: z.array(sha).min(1).max(2),
        storyId: z.uuid().optional(),
      })
      .parse(await c.req.json());
    return c.json(await studio.create(c.req.param("id")!, b));
  });
  app.get(comp, async (c) =>
    c.json(
      await studio.view(
        c.req.param("id")!,
        c.req.param("compositionId")!,
        c.req.query("commit"),
      ),
    ),
  );
  app.patch(comp, async (c) => {
    const b = Composition.pick({
      title: true,
      preset: true,
      width: true,
      height: true,
      slots: true,
      sources: true,
      allowScreenshotEdits: true,
    })
      .partial()
      .parse(await c.req.json());
    return c.json(
      await studio.update(c.req.param("id")!, c.req.param("compositionId")!, b),
    );
  });
  app.post(comp + "/restore", async (c) => {
    const b = z
      .object({ commit: z.string().regex(/^[a-f0-9]{40}$/) })
      .parse(await c.req.json());
    return c.json(
      await studio.restore(
        c.req.param("id")!,
        c.req.param("compositionId")!,
        b.commit,
      ),
    );
  });
  app.get(comp + "/check", async (c) => {
    const r = await studio.render(
      c.req.param("id")!,
      c.req.param("compositionId")!,
      { commit: c.req.query("commit") },
    );
    return c.json(r.fidelity);
  });
  app.get(comp + "/thumbnail", async (c) => {
    const bytes = await studio.thumbnail(
      c.req.param("id")!,
      c.req.param("compositionId")!,
      c.req.query("commit"),
    );
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(bytes));
  });
  app.post(comp + "/edit", async (c) => {
    const b = z
      .strictObject({
        provider: agent,
        instruction: z.string().min(1).max(10000),
      })
      .parse(await c.req.json());
    return c.json(
      studio.task("image.edit", c.req.param("id")!, {
        ...b,
        compositionId: c.req.param("compositionId")!,
      }),
    );
  });
  app.post(comp + "/export", async (c) => {
    const b = z
      .strictObject({
        format: z.enum(["png", "jpeg"]).default("png"),
        size: ImageSize.optional(),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
      })
      .parse(await c.req.json());
    const r = await studio.export(
      c.req.param("id")!,
      c.req.param("compositionId")!,
      b,
    );
    c.header("Content-Type", r.asset.mime);
    c.header(
      "Content-Disposition",
      `attachment; filename="image-${r.commit.slice(0, 8)}.${b.format === "png" ? "png" : "jpg"}"`,
    );
    c.header("X-BIP-Asset", r.asset.sha);
    return c.body(new Uint8Array(r.bytes));
  });
  const post = base + "/stories/:storyId/posts/:postId";
  app.put(post + "/media", async (c) => {
    const b = z
      .strictObject({
        media: z
          .array(z.strictObject({ sha, alt: z.string().max(1000).optional() }))
          .max(8),
      })
      .parse(await c.req.json());
    for (const m of b.media) await studio.assets.get(c.req.param("id")!, m.sha);
    const s = await studio.content.projects.store(c.req.param("id")!);
    return c.json(
      await s.updatePost(c.req.param("storyId")!, c.req.param("postId")!, {
        media: b.media,
        approvedRevisionId: undefined,
        status: "draft",
      }),
    );
  });
  app.post(base + "/assets/:sha/alt", async (c) => {
    const b = z
      .strictObject({
        provider: agent,
        context: z.string().max(10000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      studio.task("image.alt", c.req.param("id")!, {
        ...b,
        sha: sha.parse(c.req.param("sha")),
      }),
    );
  });
}
