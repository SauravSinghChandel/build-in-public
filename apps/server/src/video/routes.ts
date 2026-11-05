import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { VideoComposition, VideoCaptureInput } from "@bip/shared";
import type { VideoStudio } from "./studio.js";
export function videoRoutes(app: Hono, studio: VideoStudio) {
  const base = "/api/projects/:id/video",
    comp = base + "/compositions/:compositionId";
  const agent = z.enum(["claude", "codex"]),
    sha = z.string().regex(/^[a-f0-9]{64}$/),
    commit = z.string().regex(/^[a-f0-9]{40}$/);
  app.post(base + "/capture", async (c) =>
    c.json(
      studio.task(
        "video.capture",
        c.req.param("id")!,
        VideoCaptureInput.parse(await c.req.json()),
      ),
    ),
  );
  app.post(base + "/describe", async (c) =>
    c.json(
      studio.task(
        "video.steps",
        c.req.param("id")!,
        z
          .strictObject({
            provider: agent,
            description: z.string().min(1).max(10000),
          })
          .parse(await c.req.json()),
      ),
    ),
  );
  app.use(
    base + "/import",
    bodyLimit({
      maxSize: 500 * 1024 * 1024 + 65536,
      onError: (c) =>
        c.json({ error: { message: "Video must be at most 500 MB" } }, 413),
    }),
  );
  app.post(base + "/import", async (c) => {
    const body = await c.req.parseBody();
    if (!(body.file instanceof File)) throw Error("Choose a video");
    return c.json(
      await studio.import(
        c.req.param("id")!,
        Buffer.from(await body.file.arrayBuffer()),
        body.file.name,
      ),
    );
  });
  app.get(base + "/compositions", async (c) =>
    c.json(await studio.list(c.req.param("id")!)),
  );
  app.post(base + "/compositions", async (c) => {
    const input = z
      .strictObject({
        sources: z.array(sha).min(1).max(30),
        style: z.enum(["clean", "technical"]).default("clean"),
        storyId: z.uuid().optional(),
        brief: z.string().max(10000).optional(),
      })
      .parse(await c.req.json());
    return c.json(await studio.create(c.req.param("id")!, input));
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
    const patch = z
      .strictObject({
        title: VideoComposition.shape.title.optional(),
        style: VideoComposition.shape.style.optional(),
        captions: VideoComposition.shape.captions.optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await studio.update(
        c.req.param("id")!,
        c.req.param("compositionId")!,
        patch,
      ),
    );
  });
  app.post(comp + "/restore", async (c) => {
    const b = z.strictObject({ commit }).parse(await c.req.json());
    return c.json(
      await studio.restore(
        c.req.param("id")!,
        c.req.param("compositionId")!,
        b.commit,
      ),
    );
  });
  app.post(comp + "/edit", async (c) => {
    const b = z
      .strictObject({
        provider: agent,
        instruction: z.string().min(1).max(10000),
      })
      .parse(await c.req.json());
    return c.json(
      studio.task("video.edit", c.req.param("id")!, {
        ...b,
        compositionId: c.req.param("compositionId")!,
      }),
    );
  });
  app.post(comp + "/render", async (c) => {
    const b = z
      .strictObject({
        commit,
        variant: z
          .enum(["landscape", "square", "vertical"])
          .default("landscape"),
        force: z.boolean().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      studio.task("video.final", c.req.param("id")!, {
        ...b,
        compositionId: c.req.param("compositionId")!,
      }),
    );
  });
}
