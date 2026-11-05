import type { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Accounts } from "./accounts.js";
import type { Publisher } from "./publisher.js";

const Platform = z.enum(["x", "linkedin"]);
const cookieName = (platform: string) => `bip_oauth_${platform}`;

export function publishingRoutes(
  app: Hono,
  accounts: Accounts,
  publisher: Publisher,
  options: { dev: boolean },
) {
  app.get("/api/accounts", (c) =>
    c.json(accounts.view(c.req.query("metadata") !== "1")),
  );
  app.put("/api/accounts/:platform/app", async (c) => {
    const platform = Platform.parse(c.req.param("platform"));
    const b = z
      .strictObject({
        clientId: z.string().trim().min(1).max(200),
        clientSecret: z.string().trim().max(500).optional(),
      })
      .parse(await c.req.json());
    accounts.saveApp(platform, b.clientId, b.clientSecret || undefined);
    return c.json(accounts.view());
  });
  app.post("/api/accounts/:platform/connect", (c) => {
    const platform = Platform.parse(c.req.param("platform"));
    const { url, nonce } = accounts.begin(platform);
    // Binds the callback to this browser. Lax: the platform redirects back top-level.
    setCookie(c, cookieName(platform), nonce, {
      path: `/oauth/${platform}`,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 600,
    });
    return c.json({ url });
  });
  app.delete("/api/accounts/:platform", async (c) => {
    const platform = Platform.parse(c.req.param("platform"));
    const result = await accounts.disconnect(platform);
    return c.json({ ...result, view: accounts.view() });
  });
  // The only unauthenticated routes. The global middleware still enforces Host;
  // `state` (random, single-use, 10 min), the browser nonce and PKCE guard the rest.
  app.get("/oauth/:platform/callback", async (c) => {
    const parsed = Platform.safeParse(c.req.param("platform"));
    if (!parsed.success) return c.text("Unknown platform", 404);
    const platform = parsed.data;
    const nonce = getCookie(c, cookieName(platform));
    setCookie(c, cookieName(platform), "", {
      path: `/oauth/${platform}`,
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
    });
    const base = options.dev ? "http://127.0.0.1:5173" : "";
    const q = c.req.query();
    try {
      await accounts.complete(
        platform,
        {
          code: q.code,
          state: q.state,
          error: q.error,
          error_description: q.error_description,
        },
        nonce,
      );
      return c.redirect(`${base}/settings?section=accounts&connected=${platform}`);
    } catch (e) {
      const message = accounts.scrubber.scrub(
        e instanceof Error ? e.message : String(e),
      );
      return c.redirect(
        `${base}/settings?section=accounts&oauthError=${encodeURIComponent(message)}`,
      );
    }
  });
  const post = "/api/projects/:id/stories/:storyId/posts/:postId";
  app.post(post + "/post-now", async (c) => {
    const { revisionId, retryUncertain } = z
      .strictObject({ revisionId: z.uuid(), retryUncertain: z.boolean().default(false) })
      .parse(await c.req.json());
    return c.json(
      await publisher.postNow(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
        revisionId,
        retryUncertain,
      ),
    );
  });
  app.post(post + "/confirm-posted", async (c) => {
    const { url } = z.strictObject({ url: z.url() }).parse(await c.req.json());
    return c.json(
      await publisher.confirmPosted(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
        url,
      ),
    );
  });
  app.post(post + "/schedule", async (c) => {
    const b = z
      .strictObject({ revisionId: z.uuid(), scheduledAt: z.iso.datetime({ offset: true }) })
      .parse(await c.req.json());
    return c.json(
      await publisher.schedule(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
        b.revisionId,
        b.scheduledAt,
      ),
    );
  });
  app.post(post + "/unschedule", async (c) =>
    c.json(
      await publisher.unschedule(
        c.req.param("id")!,
        c.req.param("storyId")!,
        c.req.param("postId")!,
      ),
    ),
  );
}
