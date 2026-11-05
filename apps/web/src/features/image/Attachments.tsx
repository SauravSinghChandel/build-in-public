import { useEffect, useState } from "react";
import {
  type AssetData,
  type JobView,
  type PostData,
  type ProjectRow,
} from "@bip/shared";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message } from "../../components/workspace";
import { AgentPicker, JobFeedback, useJobs } from "../studio/jobs";
import { useAssets, Media, assetUrl } from "./Media";
export function Attachments({ p, post }: { p: ProjectRow; post: PostData }) {
  const [open, setOpen] = useState(false),
    [agent, setAgent] = useState<"claude" | "codex">("claude"),
    [altJob, setAltJob] = useState<{ id: string; sha: string }>(),
    [alts, setAlts] = useState<Record<string, string>>({});
  const assets = useAssets(p.id);
  const isVideo = (sha: string) =>
    assets.data?.some((a) => a.sha === sha && a.mime.startsWith("video/"));
  const q = useQueryClient(),
    jobs = useJobs();
  const job = jobs.data?.find((j) => j.id === altJob?.id);
  const save = async (media: PostData["media"]) => {
    await api(
      `/projects/${p.id}/stories/${post.storyId}/posts/${post.id}/media`,
      "PUT",
      { media },
    );
    await q.invalidateQueries({ queryKey: ["stories", p.id] });
  };
  useEffect(() => {
    if (job?.status === "succeeded" && altJob) {
      const text = job.result.alt;
      setAlts((a) => ({ ...a, [altJob.sha]: text }));
      void save(
        post.media.map((m) => (m.sha === altJob.sha ? { ...m, alt: text } : m)),
      ).catch(message);
    }
  }, [job?.status, job?.id]);
  const pick = (asset: AssetData) => {
    void save([
      ...post.media.filter((m) => m.sha !== asset.sha),
      { sha: asset.sha, alt: "" },
    ])
      .then(() => setOpen(false))
      .catch(message);
  };
  return (
    <div className="attached-media">
      <h3>Media</h3>
      {post.media.map((m) =>
        isVideo(m.sha) ? (
          <div className="attached-image" key={m.sha}>
            <span className="chip">Video</span>
            <video src={assetUrl(p.id, m.sha)} controls preload="metadata" />
            <Button
              onClick={() =>
                void save(post.media.filter((v) => v.sha !== m.sha)).catch(
                  message,
                )
              }
            >
              Remove video
            </Button>
          </div>
        ) : (
          <div className="attached-image" key={m.sha}>
            <img src={assetUrl(p.id, m.sha)} alt={m.alt || "Attached image"} />

            <label className="field">
              Alt text
              <input
                value={alts[m.sha] ?? m.alt ?? ""}
                onChange={(e) =>
                  setAlts((a) => ({ ...a, [m.sha]: e.target.value }))
                }
                onBlur={() =>
                  void save(
                    post.media.map((v) =>
                      v.sha === m.sha ? { ...v, alt: alts[m.sha] ?? m.alt } : v,
                    ),
                  ).catch(message)
                }
              />
            </label>
            <div className="actions">
              <Button
                disabled={
                  isVideo(m.sha) ||
                  ["queued", "running"].includes(job?.status || "")
                }
                onClick={() =>
                  void api<JobView>(
                    `/projects/${p.id}/assets/${m.sha}/alt`,
                    "POST",
                    {
                      provider: agent,
                      context: "Image attached to a " + post.platform + " post",
                    },
                  )
                    .then((j) => setAltJob({ id: j.id, sha: m.sha }))
                    .catch(message)
                }
              >
                Suggest alt text
              </Button>
              <Button
                onClick={() =>
                  void save(post.media.filter((v) => v.sha !== m.sha)).catch(
                    message,
                  )
                }
              >
                Remove media
              </Button>
            </div>
          </div>
        ),
      )}
      {post.media.some((m) => !isVideo(m.sha)) && (
        <AgentPicker p={p} task="image.alt" value={agent} onChange={setAgent} />
      )}
      <JobFeedback job={job} />
      <Button onClick={() => setOpen(true)}>Add image</Button>
      {open && (
        <Dialog
          open
          title="Add image"
          onOpenChange={(v) => !v && setOpen(false)}
        >
          <Media p={p} onPick={pick} storyId={post.storyId} />
        </Dialog>
      )}
    </div>
  );
}
export function PublishImages({
  project,
  post,
}: {
  project: string;
  post: PostData;
}) {
  const assets = useAssets(project);
  return (
    <>
      {post.media.map((m) =>
        assets.data?.some(
          (a) => a.sha === m.sha && a.mime.startsWith("video/"),
        ) ? (
          <div className="attached-image" key={m.sha}>
            <span className="chip">Video</span>
            <video controls src={assetUrl(project, m.sha)} />
            <a
              className="button secondary"
              href={assetUrl(project, m.sha) + "?download=1"}
              download
            >
              Download video
            </a>
          </div>
        ) : (
          <div className="attached-image" key={m.sha}>
            <img
              src={assetUrl(project, m.sha)}
              alt={m.alt || "Attached image"}
            />
            <p className="muted">{m.alt || "No alt text yet"}</p>
            <div className="actions">
              <a
                className="button secondary"
                href={assetUrl(project, m.sha) + "?download=1"}
                download
              >
                Download image
              </a>
              {typeof ClipboardItem !== "undefined" &&
                navigator.clipboard?.write && (
                  <Button
                    onClick={() =>
                      void fetch(assetUrl(project, m.sha))
                        .then((r) => r.blob())
                        .then(async (blob) => {
                          // Clipboard APIs generally accept PNG only; convert JPEG/WebP through a canvas.
                          const bitmap = await createImageBitmap(blob),
                            canvas = document.createElement("canvas");
                          canvas.width = bitmap.width;
                          canvas.height = bitmap.height;
                          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
                          bitmap.close();
                          const png = await new Promise<Blob>(
                            (resolve, reject) =>
                              canvas.toBlob(
                                (b) =>
                                  b
                                    ? resolve(b)
                                    : reject(Error("Couldn't copy the image. Use Download image instead.")),
                                "image/png",
                              ),
                          );
                          await navigator.clipboard.write([
                            new ClipboardItem({ "image/png": png }),
                          ]);
                        })
                        .catch(message)
                    }
                  >
                    Copy image
                  </Button>
                )}
            </div>
          </div>
        ),
      )}
    </>
  );
}
