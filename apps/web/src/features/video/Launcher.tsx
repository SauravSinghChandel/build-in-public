import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  VideoCaptureInput,
  type ProjectRow,
  type StoryView,
  type VideoView,
  type JobView,
  type AssetData,
  type StepCheck,
} from "@bip/shared";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message } from "../../components/workspace";
import { useAssets, assetUrl, assetLabel } from "../image/Media";
import { CaptureSteps, StepCheckSummary } from "../image/CaptureSteps";
import { AgentPicker, JobFeedback, useJobs } from "../studio/jobs";
import { VideoStudio } from "./Studio";
export function VideoLauncher({
  p,
  story,
}: {
  p: ProjectRow;
  story?: StoryView;
}) {
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState(""),
    [studio, setStudio] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const assets = useAssets(p.id),
    q = useQueryClient(),
    base = `/projects/${p.id}/video`;
  const compositions = useQuery({
    queryKey: ["videos", p.id],
    queryFn: () => api<VideoView[]>(base + "/compositions"),
  });
  const create = async () => {
    setBusy(true);
    try {
      const v = await api<VideoView>(base + "/compositions", "POST", {
        sources: selected,
        style: "clean",
        storyId: story?.story.id,
        brief: story?.story.brief,
      });
      setStudio(v.composition.id);
      setMode("");
      setOpen(false);
      void q.invalidateQueries();
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api" + base + "/import", {
        method: "POST",
        body: form,
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error.message);
      setSelected([data.sha]);
      await q.invalidateQueries({ queryKey: ["assets", p.id] });
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const images = mode === "images",
    candidates =
      assets.data?.filter((a) =>
        images
          ? ["image_render", "screenshot", "upload"].includes(a.kind)
          : a.kind === "recording",
      ) || [];
  return (
    <div className="video-launcher">
      <Button onClick={() => setOpen(true)}>
        {story ? "Add video" : "New video"}
      </Button>
      {compositions.data
        ?.filter((v) => !story || v.composition.storyId === story.story.id)
        .map((v) => (
          <Button
            key={v.composition.id}
            onClick={() => setStudio(v.composition.id)}
          >
            Open video · {v.composition.title}
          </Button>
        ))}
      {open && (
        <Dialog
          open
          title="Add video"
          onOpenChange={(v) => !v && setOpen(false)}
        >
          <div className="actions">
            <Button
              onClick={() => {
                setMode("capture");
                setOpen(false);
              }}
            >
              Record a demo
            </Button>
            <Button
              onClick={() => {
                setMode("recordings");
                setSelected([]);
              }}
            >
              Use a recording
            </Button>
            <Button
              onClick={() => {
                setMode("images");
                setSelected([
                  ...new Set(
                    story?.posts
                      .flatMap((v) => v.post.media.map((m) => m.sha))
                      .filter((sha) =>
                        assets.data?.some(
                          (a) => a.sha === sha && a.mime.startsWith("image/"),
                        ),
                      ) || [],
                  ),
                ]);
              }}
            >
              From images in this story
            </Button>
          </div>
          {(mode === "images" || mode === "recordings") && (
            <>
              <p>
                {images
                  ? "Screenshots to video · slow pan, zoom, and captions"
                  : "Choose a recording or import MP4, MOV, WebM (≤ 500 MB)"}
              </p>
              {!images && (
                <label className="field">
                  Import video
                  <input
                    aria-label="Import video"
                    type="file"
                    accept=".mp4,.mov,.webm"
                    disabled={busy}
                    onChange={(e) => {
                      if (e.target.files?.[0]) void upload(e.target.files[0]);
                    }}
                  />
                </label>
              )}
              {candidates.map((a) => (
                <label className="check-row" key={a.sha}>
                  <input
                    type="checkbox"
                    checked={selected.includes(a.sha)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, a.sha]
                          : selected.filter((s) => s !== a.sha),
                      )
                    }
                  />
                  {images && (
                    <img width={80} src={assetUrl(p.id, a.sha)} alt="Source" />
                  )}
                  {a.provenance.type === "video_import"
                    ? a.provenance.filename
                    : a.provenance.type === "video_capture"
                      ? `Recording of ${a.provenance.url} · ${new Date(a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                      : assetLabel(a)}{" "}
                  {a.quality?.choppy && (
                    <span
                      className="chip"
                      title={`Heavy animation on this page: ${a.quality.effectiveFps.toFixed(1)} fps delivered, longest gap ${Math.round(a.quality.maxGapMs)} ms. Record again, or pause the animation first.`}
                    >
                      Heavy animation on this page · Record again
                    </span>
                  )}
                </label>
              ))}
              <Button
                disabled={!selected.length || busy}
                onClick={() => void create()}
              >
                {busy ? "Preparing…" : "Create video"}
              </Button>
            </>
          )}
        </Dialog>
      )}
      {mode === "capture" && !open && (
        <RecordDialog
          p={p}
          storyId={story?.story.id}
          onClose={() => setMode("")}
          onCreated={(id) => {
            setStudio(id);
            setMode("");
            void q.invalidateQueries();
          }}
        />
      )}
      {studio && (
        <VideoStudio
          p={p}
          id={studio}
          story={story}
          onClose={() => {
            setStudio("");
            void q.invalidateQueries();
          }}
          onRecordAgain={() => {
            setStudio("");
            setMode("capture");
          }}
        />
      )}
    </div>
  );
}
function RecordDialog({
  p,
  storyId,
  onClose,
  onCreated,
}: {
  p: ProjectRow;
  storyId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [url, setUrl] = useState("http://localhost:3000"),
    [viewport, setViewport] = useState("1440x900"),
    [steps, setSteps] = useState('[{"action":"pause","ms":3000}]'),
    [approved, setApproved] = useState(false),
    [description, setDescription] = useState(""),
    [agent, setAgent] = useState<"claude" | "codex">("claude"),
    [describe, setDescribe] = useState(""),
    [capture, setCapture] = useState(""),
    [checks, setChecks] = useState<StepCheck[] | undefined>(),
    [error, setError] = useState("");
  const jobs = useJobs(),
    q = useQueryClient(),
    dj = jobs.data?.find((j) => j.id === describe),
    cj = jobs.data?.find((j) => j.id === capture),
    active = jobs.data?.some(
      (j) =>
        [describe, capture].includes(j.id) &&
        ["queued", "running"].includes(j.status),
    );
  useEffect(() => {
    if (dj?.status === "succeeded") {
      setSteps(JSON.stringify(dj.result.steps, null, 2));
      setChecks(dj.result.checks);
      setApproved(false);
    }
  }, [dj?.status, describe]);
  useEffect(() => {
    if (cj?.status === "succeeded") onCreated(cj.result.compositionId);
  }, [cj?.status]);
  const change = (s: string) => {
    setSteps(s);
    setChecks(undefined);
    setApproved(false);
  };
  const run = async () => {
    try {
      const input = VideoCaptureInput.parse({
        url,
        viewport,
        steps: JSON.parse(steps),
        approved,
        storyId,
      });
      const job = await api<JobView>(
        `/projects/${p.id}/video/capture`,
        "POST",
        input,
      );
      setCapture(job.id);
      void q.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Dialog
      open
      sheet
      title="Record a demo"
      onOpenChange={(v) => !v && onClose()}
    >
      <div className="capture-form">
        <fieldset disabled={active}>
          <label className="field">
            URL
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setApproved(false);
              }}
            />
          </label>
          <label className="field">
            Viewport
            <select
              value={viewport}
              onChange={(e) => {
                setViewport(e.target.value);
                setApproved(false);
              }}
            >
              {["1440x900", "1280x800", "390x844"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Describe the demo
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <AgentPicker
            p={p}
            task="video.steps"
            value={agent}
            onChange={setAgent}
          />
          <Button
            disabled={!description}
            onClick={() =>
              void api<JobView>(`/projects/${p.id}/video/describe`, "POST", {
                description,
                provider: agent,
                url,
                viewport,
              })
                .then((j) => {
                  setDescribe(j.id);
                  setApproved(false);
                  return q.invalidateQueries({ queryKey: ["jobs"] });
                })
                .catch(message)
            }
          >
            Generate steps
          </Button>
          <JobFeedback job={dj} />
          <StepCheckSummary checks={checks} />
          <CaptureSteps video steps={steps} checks={checks} onChange={change} />
          <label className="field">
            Steps JSON
            <textarea
              rows={7}
              className="mono"
              value={steps}
              onChange={(e) => change(e.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I reviewed and approve these steps
          </label>
          <p className="muted">
            Recording begins after network idle and fonts load. Steps run in a
            fresh browser with no saved cookies.
          </p>
          <Button disabled={!approved} onClick={() => void run()}>
            Run recording
          </Button>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <JobFeedback job={cj} />
      </div>
    </Dialog>
  );
}
