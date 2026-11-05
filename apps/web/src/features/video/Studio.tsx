import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog as Primitive } from "radix-ui";
import type {
  VideoView,
  VideoCompositionData,
  ProjectRow,
  StoryView,
  JobView,
} from "@bip/shared";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { message, ErrorBox } from "../../components/workspace";
import { AgentPicker, JobFeedback, useJobs } from "../studio/jobs";
import { assetUrl } from "../image/Media";
export function VideoStudio({
  p,
  id,
  story,
  onClose,
  onRecordAgain,
}: {
  p: ProjectRow;
  id: string;
  story?: StoryView;
  onClose: () => void;
  onRecordAgain: () => void;
}) {
  const base = `/projects/${p.id}/video/compositions/${id}`,
    q = useQueryClient(),
    jobs = useJobs(),
    player = useRef<HTMLVideoElement>(null);
  const [revision, setRevision] = useState(""),
    [captions, setCaptions] = useState<VideoCompositionData["captions"]>([]),
    [instruction, setInstruction] = useState(""),
    [agent, setAgent] = useState<"claude" | "codex">("claude"),
    [captionAgent, setCaptionAgent] = useState<"claude" | "codex">("claude"),
    [sheet, setSheet] = useState(false),
    [frame, setFrame] = useState(0),
    [variant, setVariant] = useState("landscape"),
    [busy, setBusy] = useState(false),
    [attachTarget, setAttachTarget] = useState(""),
    [renderJob, setRenderJob] = useState("");
  const view = useQuery({
    queryKey: ["video", p.id, id, revision],
    queryFn: () =>
      api<VideoView>(base + (revision ? "?commit=" + revision : "")),
    refetchInterval: 3000,
  });
  const data = view.data,
    config = data?.composition,
    current = data?.revisions.find((r) => r.commit === data.commit),
    downloadSha =
      variant === "square"
        ? current?.squareSha
        : variant === "vertical"
          ? current?.verticalSha
          : current?.finalSha,
    src = downloadSha || current?.previewSha;
  const related =
      jobs.data?.filter((j) => j.payload.compositionId === id) || [],
    active = related.find((j) => ["queued", "running"].includes(j.status)),
    edit = related.find((j) => j.type === "video.edit"),
    suggest = related.find((j) => j.type === "video.captions"),
    final = related.find((j) => j.id === renderJob);
  const progress = useQuery<Record<string, string>>({
    queryKey: ["partials"],
    queryFn: () => ({}),
    enabled: false,
  });
  useEffect(() => {
    if (config) setCaptions(config.captions);
  }, [data?.commit]);
  const adopt = async () => {
    await q.invalidateQueries({ queryKey: ["video", p.id, id] });
    await q.invalidateQueries({ queryKey: ["jobs"] });
  };
  const captionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const captionDirty =
    !!config &&
    captions.length === config.captions.length &&
    JSON.stringify(captions) !== JSON.stringify(config.captions);
  const patch = async (patch: Partial<VideoCompositionData>) => {
    setBusy(true);
    try {
      await api(base, "PATCH", patch);
      await adopt();
      return true;
    } catch (e) {
      message(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!captionDirty || revision) return;
    captionTimer.current = setTimeout(() => void patch({ captions }), 500);
    return () => clearTimeout(captionTimer.current);
  }, [captions, data?.commit, revision]);
  const close = async () => {
    clearTimeout(captionTimer.current);
    if (captionDirty && !(await patch({ captions }))) return;
    onClose();
  };
  const seek = (ms: number) => {
    const f = Math.max(
      0,
      Math.min(
        Math.round((ms / 1000) * 30),
        Math.ceil(((config?.durationMs || 0) / 1000) * 30) - 1,
      ),
    );
    setFrame(f);
    if (player.current) player.current.currentTime = f / 30;
  };
  const attach = async (sha: string, postId: string) => {
    const post = story?.posts.find((v) => v.post.id === postId)?.post;
    if (!post) return;
    await api(
      `/projects/${p.id}/stories/${post.storyId}/posts/${post.id}/media`,
      "PUT",
      { media: [...post.media.filter((m) => m.sha !== sha), { sha }] },
    );
    await q.invalidateQueries({ queryKey: ["stories", p.id] });
    setAttachTarget("");
  };
  useEffect(() => {
    if (final?.status === "succeeded" && attachTarget)
      void attach(final.result.sha, attachTarget).catch(message);
  }, [final?.status, attachTarget]);
  const render = async (target?: string) => {
    try {
      const job = await api<JobView>(base + "/render", "POST", {
        commit: data!.commit,
        variant,
      });
      setRenderJob(job.id);
      if (target) setAttachTarget(target);
      await adopt();
    } catch (e) {
      message(e);
    }
  };
  return (
    <Primitive.Root open>
      <Primitive.Portal>
        <Primitive.Content className="video-studio" aria-label="Video Studio">
          <Primitive.Title className="sr-only">Video Studio</Primitive.Title>
          <Primitive.Description className="sr-only">
            Preview, revise and export a video
          </Primitive.Description>
          <div className="studio-top">
            <strong>{config?.title || "Video Studio"}</strong>
            {data?.choppy && (
              <>
                <span
                  className="chip"
                  role="note"
                  title="The page's animation kept Chromium from delivering frames steadily (under 12 fps or a gap over 500 ms), so motion in this recording may stutter."
                >
                  Heavy animation on this page
                </span>
                <Button onClick={onRecordAgain}>Record again</Button>
              </>
            )}
            {active ? (
              <span className="chip" role="status">
                {progress.data?.[active.id] ||
                  (active.type === "video.contact"
                    ? "Building contact sheet…"
                    : "Rendering…")}
              </span>
            ) : (
              current?.previewSha && <span className="chip">Lint passed</span>
            )}
            <select
              aria-label="Render variant"
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
            >
              <option value="landscape">1920 × 1080</option>
              <option value="square">1080 × 1080</option>
              <option value="vertical">1080 × 1920</option>
            </select>
            <Button
              disabled={!data || !!active || busy || captionDirty}
              onClick={() => void render()}
            >
              Render final
            </Button>
            {downloadSha && (
              <a
                className="button secondary"
                href={assetUrl(p.id, downloadSha!) + "?download=1"}
                download
              >
                Download final MP4
              </a>
            )}
            <Button disabled={busy} onClick={() => void close()}>
              Close
            </Button>
          </div>
          {view.error && <ErrorBox error={view.error} />}
          {data && config && (
            <>
              <div className="video-body">
                <main className="video-main">
                  <div className="video-stage">
                    {src ? (
                      <video
                        key={src}
                        ref={player}
                        src={assetUrl(p.id, src)}
                        controls
                        preload="auto"
                        onTimeUpdate={(e) =>
                          setFrame(
                            Math.max(
                              0,
                              Math.min(
                                Math.ceil((config.durationMs / 1000) * 30) - 1,
                                Math.round(e.currentTarget.currentTime * 30),
                              ),
                            ),
                          )
                        }
                      />
                    ) : (
                      <p role="status">Preparing the preview…</p>
                    )}
                    {sheet && current?.contactSha && (
                      <img
                        className="video-contact"
                        src={assetUrl(p.id, current.contactSha)}
                        alt="Contact sheet of twelve frames"
                      />
                    )}
                  </div>
                  <div className="actions">
                    <Button
                      disabled={!current?.contactSha}
                      aria-pressed={sheet}
                      onClick={() => setSheet(!sheet)}
                    >
                      Contact sheet
                    </Button>
                    <Button
                      aria-label="Previous frame"
                      onClick={() => seek(((frame - 1) / 30) * 1000)}
                    >
                      −1 frame
                    </Button>
                    <Button
                      aria-label="Next frame"
                      onClick={() => seek(((frame + 1) / 30) * 1000)}
                    >
                      +1 frame
                    </Button>
                    <span className="mono">
                      Frame {frame} · {(frame / 30).toFixed(3)} s
                    </span>
                  </div>
                  <input
                    aria-label="Frame scrubber"
                    type="range"
                    min={0}
                    max={Math.max(
                      0,
                      Math.ceil((config.durationMs / 1000) * 30) - 1,
                    )}
                    step={1}
                    value={frame}
                    onChange={(e) => seek((Number(e.target.value) / 30) * 1000)}
                  />
                  <div className="scene-timeline" aria-label="Scene timeline">
                    {config.scenes.map((s) => (
                      <button
                        key={s.id}
                        style={{
                          left: `${(s.startMs / config.durationMs) * 100}%`,
                          width: `${((s.endMs - s.startMs) / config.durationMs) * 100}%`,
                        }}
                        onClick={() => seek(s.startMs)}
                        title={s.notes}
                      >
                        {s.kind}
                      </button>
                    ))}
                  </div>
                  <div
                    className="timeline-markers"
                    aria-label="Caption and click markers"
                  >
                    {config.captions.map((c, i) => (
                      <button
                        key={"cap" + i}
                        className="caption-marker"
                        style={{
                          left: `${(c.startMs / config.durationMs) * 100}%`,
                        }}
                        title={c.text}
                        aria-label={`Caption ${i + 1} marker`}
                        onClick={() => seek(c.startMs)}
                      >
                        ▰
                      </button>
                    ))}
                    {data.clicks.map((c, i) => (
                      <button
                        key={"click" + i}
                        className="click-marker"
                        style={{
                          left: `${((c.t * 1000) / config.durationMs) * 100}%`,
                        }}
                        title={`Click at ${c.t.toFixed(3)}s`}
                        aria-label={`Click ${i + 1} marker`}
                        onClick={() => seek(c.t * 1000)}
                      >
                        ●
                      </button>
                    ))}
                  </div>
                  {config.durationMs > 140000 && (
                    <p role="alert">
                      This video exceeds X's 2:20 duration limit. Shorten it
                      before exporting for X.
                    </p>
                  )}
                  <JobFeedback
                    job={related.find((j) => j.status === "failed")}
                  />
                </main>
                <aside className="studio-right">
                  <fieldset disabled={!!revision || !!active || busy}>
                    <label className="field">
                      Style
                      <select
                        value={config.style}
                        onChange={(e) =>
                          void patch({
                            style: e.target.value as "clean" | "technical",
                          })
                        }
                      >
                        <option value="clean">Clean</option>
                        <option value="technical">Technical</option>
                      </select>
                    </label>
                    <h2>Captions</h2>
                    {!captions.length && (
                      <div className="caption-suggest">
                        <p className="muted">
                          No captions yet. Add a story brief, or suggest
                          captions from the project and this recording.
                        </p>
                        <AgentPicker
                          p={p}
                          task="video.captions"
                          value={captionAgent}
                          onChange={setCaptionAgent}
                        />
                        <Button
                          onClick={() =>
                            void api(base + "/captions/suggest", "POST", {
                              provider: captionAgent,
                            })
                              .then(adopt)
                              .catch(message)
                          }
                        >
                          Suggest captions
                        </Button>
                      </div>
                    )}
                    {captions.map((c, i) => (
                      <label className="field" key={i}>
                        Caption {i + 1}
                        <input
                          aria-label={`Caption ${i + 1}`}
                          value={c.text}
                          onChange={(e) =>
                            setCaptions((cs) =>
                              cs.map((s, n) =>
                                n === i ? { ...s, text: e.target.value } : s,
                              ),
                            )
                          }
                        />
                        <small>
                          {(c.startMs / 1000).toFixed(2)}–
                          {(c.endMs / 1000).toFixed(2)} s
                        </small>
                      </label>
                    ))}
                    <label className="field">
                      Instruction
                      <textarea
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder="What would you change?"
                      />
                    </label>
                    <AgentPicker
                      p={p}
                      task="video.edit"
                      value={agent}
                      onChange={setAgent}
                    />
                    <Button
                      disabled={!instruction.trim() || captionDirty}
                      onClick={() =>
                        void api(base + "/edit", "POST", {
                          provider: agent,
                          instruction,
                        })
                          .then(adopt)
                          .catch(message)
                      }
                    >
                      Apply
                    </Button>
                  </fieldset>
                  <JobFeedback job={suggest} />
                  <JobFeedback job={edit} />
                  {story?.posts.map(({ post }) => (
                    <Button
                      key={post.id}
                      disabled={!!active || !data || busy || captionDirty}
                      onClick={() => {
                        if (downloadSha)
                          void attach(downloadSha, post.id).catch(message);
                        else void render(post.id);
                      }}
                    >
                      Attach to {post.platform === "x" ? "X" : "LinkedIn"} post
                    </Button>
                  ))}
                </aside>
              </div>
              <div className="studio-revisions" aria-label="Video revisions">
                {data.revisions.map((r, i) => (
                  <article className="studio-revision" key={r.commit}>
                    {r.contactSha && (
                      <img
                        src={assetUrl(p.id, r.contactSha)}
                        alt={`Revision ${i + 1} thumbnail`}
                      />
                    )}
                    <strong>Revision {i + 1}</strong>
                    <small title={r.instruction}>{r.instruction}</small>
                    <pre>{r.diffStat}</pre>
                    {r.largeChange && (
                      <span className="chip">Large change</span>
                    )}
                    <div className="actions">
                      <Button
                        aria-label={`Preview revision ${i + 1}`}
                        aria-pressed={data.commit === r.commit}
                        onClick={() => {
                          setRevision(r.commit);
                          seek(0);
                        }}
                      >
                        Preview
                      </Button>
                      <Button
                        aria-label={`Restore revision ${i + 1}`}
                        disabled={!!active || busy}
                        onClick={() =>
                          void api(base + "/restore", "POST", {
                            commit: r.commit,
                          })
                            .then(() => {
                              setRevision("");
                              return adopt();
                            })
                            .catch(message)
                        }
                      >
                        Restore
                      </Button>
                    </div>
                  </article>
                ))}
                {revision && (
                  <Button onClick={() => setRevision("")}>
                    Back to latest
                  </Button>
                )}
              </div>
            </>
          )}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
