import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { ensureConfig, appPort } from "./config.js";
import { createApp } from "./app.js";
export async function start() {
  await ensureConfig();
  const service = createApp({ port: appPort() });
  await service.projects.rescan();
  const server = serve(
    { fetch: service.app.fetch, hostname: "127.0.0.1", port: service.port },
    () => {
      const url = `http://127.0.0.1:${service.port}/?token=${service.token}`;
      console.log(`Open ${url}`);
      if (!process.env.BIP_NO_OPEN)
        execFile(
          process.platform === "darwin" ? "open" : "xdg-open",
          [url],
          () => {},
        );
    },
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void service.close().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { server, service };
}
