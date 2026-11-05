import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { Story } from "@bip/shared";
import { Content } from "./content.js";
const Agent = z.enum(["claude", "codex"]);
const SHA = z.string().regex(/^[a-f0-9]{40,64}$/);
export function contentRoutes(app: Hono, content: Content) {
  const base = "/api/projects/:id";
  app.get("/api/jobs", (c) => c.json(content.jobs.list()));
  app.post("/api/jobs/:id/cancel", (c) =>
    c.json(content.jobs.cancel(c.req.param("id")!)),
  );
  app.post("/api/jobs/:id/resume", (c) =>
    c.json(content.jobs.resume(c.req.param("id")!)),
  );
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const last = Number(c.req.header("Last-Event-ID") || 0);
      const write = (e: any) =>
        stream.writeSSE({
          id: String(e.id),
          event: "job",
          data: JSON.stringify(e),
        });
      let chain = Promise.resolve();
      const off = content.jobs.events.subscribe((e) => {
        chain = chain
          .then(async () => {
            await write(e);
          })
          .catch(() => {});
      });
      for (const e of content.jobs.events.since(last)) await write(e);
      await stream.writeSSE({ event: "connected", data: "{}" });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          chain = chain
            .then(async () => {
              await stream.writeSSE({ event: "ping", data: "{}" });
            })
            .catch(() => {});
        }, 15000);
        stream.onAbort(() => {
          clearInterval(timer);
          off();
          resolve();
        });
      });
    }),
  );
  app.get("/api/content", async (c) => c.json(await content.posts()));
  app.get(base + "/stories", async (c) =>
    c.json(await content.list(c.req.param("id")!)),
  );
  app.post(base + "/stories", async (c) => {
    const b = z
      .strictObject({
        title: z.string().min(1),
        brief: z.string().default(""),
        commits: z.array(SHA).max(100).default([]),
        angle: z.string().optional(),
      })
      .parse(await c.req.json());
    const s = await content.projects.store(c.req.param("id")!);
    return c.json(
      await s.createStory({
        title: b.title,
        brief: b.brief,
        angle: b.angle,
        selectedCommits: b.commits,
        ...(b.commits.length
          ? { commitRange: { from: b.commits.at(-1)!, to: b.commits[0] } }
          : {}),
      }),
    );
  });
  app.get(base + "/stories/:storyId", async (c) =>
    c.json(await content.story(c.req.param("id")!, c.req.param("storyId")!)),
  );
  app.patch(base + "/stories/:storyId", async (c) => {
    const b = Story.pick({
      title: true,
      brief: true,
      status: true,
      angle: true,
    })
      .partial()
      .parse(await c.req.json());
    return c.json(
      await (
        await content.projects.store(c.req.param("id")!)
      ).updateStory(c.req.param("storyId")!, b),
    );
  });
  app.post(base + "/angles", async (c) => {
    const b = z
      .strictObject({
        provider: Agent,
        commits: z.array(SHA).max(100),
        note: z.string().max(10000).default(""),
      })
      .parse(await c.req.json());
    return c.json(await content.task("story.angles", c.req.param("id")!, b));
  });
  app.post(base + "/stories/:storyId/draft", async (c) => {
    const b = z
      .strictObject({ provider: Agent, angle: z.string().optional() })
      .parse(await c.req.json());
    return c.json(
      await content.task("post.draft", c.req.param("id")!, {
        ...b,
        storyId: c.req.param("storyId")!,
      }),
    );
  });
  app.post(base + "/summary", async (c) => {
    const b = z.strictObject({ provider: Agent }).parse(await c.req.json());
    return c.json(await content.task("project.summary", c.req.param("id")!, b));
  });
  app.get(base + "/summary", async (c) => {
    const s = await content.projects.store(c.req.param("id")!);
    const text = await s.readSummary();
    const { git } = await import("./git.js");
    const head = (
      await git(s.repo, ["rev-parse", "HEAD"]).catch(() => "")
    ).trim();
    return c.json({ text, stale: !!text && !text.includes(`head: ${head}\n`) });
  });
  const posts = base + "/stories/:storyId/posts";
  app.post(posts, async (c) => {
    const b = z
      .strictObject({
        platform: z.enum(["x", "linkedin"]),
        parts: z.array(z.string()).min(1).max(4),
        replyToPostId: z.uuid().optional(),
      })
      .parse(await c.req.json());
    const s = await content.projects.store(c.req.param("id")!);
    const post = await s.createPost(c.req.param("storyId")!, {
      platform: b.platform,
      replyToPostId: b.replyToPostId,
      kind: b.replyToPostId
        ? "follow_up"
        : b.parts.length > 1
          ? "thread"
          : "post",
    });
    await s.addRevision(c.req.param("storyId")!, post.id, {
      parts: b.parts,
      author: "user",
    });
    return c.json(post);
  });
  const post = posts + "/:postId";
  app.post(post + "/edit", async (c) => {
    const b = z
      .strictObject({
        provider: Agent,
        instruction: z.string().min(1).max(10000),
        followUp: z.boolean().optional(),
        sourcePostId: z.uuid().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await content.task("post.edit", c.req.param("id")!, {
        ...b,
        storyId: c.req.param("storyId")!,
        postId: c.req.param("postId")!,
      }),
    );
  });
  app.post(post + "/revisions", async (c) => {
    const b = z
      .strictObject({
        parts: z.array(z.string().max(50000)).min(1).max(4),
        coalesce: z.boolean().default(true),
      })
      .parse(await c.req.json());
    const s = await content.projects.store(c.req.param("id")!);
    const old = await s.readRevisions(
      c.req.param("storyId")!,
      c.req.param("postId")!,
    );
    const last = old.revisions.at(-1);
    return c.json(
      await s.addRevision(c.req.param("storyId")!, c.req.param("postId")!, {
        ...b,
        author: "user",
        claims: last?.claims,
        highlights: last?.highlights,
      }),
    );
  });
  app.post(post + "/restore", async (c) => {
    const { revisionId } = z
      .strictObject({ revisionId: z.uuid() })
      .parse(await c.req.json());
    const s = await content.projects.store(c.req.param("id")!);
    const { revisions } = await s.readRevisions(
      c.req.param("storyId")!,
      c.req.param("postId")!,
    );
    const index = revisions.findIndex((r) => r.id === revisionId);
    if (index < 0) throw Error("That revision no longer exists. Reload the post.");
    const old = revisions[index];
    return c.json(
      await s.addRevision(c.req.param("storyId")!, c.req.param("postId")!, {
        parts: old.parts,
        author: "user",
        instruction: `Restored revision ${index + 1}`,
        claims: old.claims,
        highlights: old.highlights,
      }),
    );
  });
  app.get(post + "/checklist", async (c) =>
    c.json(
      await content.checklist(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
      ),
    ),
  );
  app.post(post + "/approve", async (c) => {
    const b = z
      .strictObject({
        revisionId: z.uuid(),
        checked: z.array(z.number().int().min(0)),
        acknowledgePrivate: z.boolean().default(false),
      })
      .parse(await c.req.json());
    return c.json(
      await content.approve(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
        b.revisionId,
        b.checked,
        b.acknowledgePrivate,
      ),
    );
  });
  app.post(post + "/publish", async (c) => {
    const { url } = z.strictObject({ url: z.url() }).parse(await c.req.json());
    return c.json(
      await content.publish(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
        url,
      ),
    );
  });
}
