import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CaptureInput,
  type AssetData,
  type CompositionView,
  type ProjectRow,
  type JobView,
  type StepCheck,
} from "@bip/shared";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message, ErrorBox } from "../../components/workspace";
import { AgentPicker, JobFeedback, useJobs } from "../studio/jobs";
import { VideoLauncher } from "../video/Launcher";
import { CaptureSteps, StepCheckSummary } from "./CaptureSteps";
import { ImageStudio } from "./Studio";
export const assetUrl = (project: string, sha: string) =>
  `/api/projects/${project}/assets/${sha}`;
export function useAssets(project: string) {
  return useQuery({
    queryKey: ["assets", project],
    queryFn: () => api<AssetData[]>(`/projects/${project}/assets`),
    select: (rows) =>
      rows.filter((a, i) => rows.findIndex((v) => v.sha === a.sha) === i),
  });
}
export function Media({
  p,
  onPick,
  storyId,
}: {
  p: ProjectRow;
  onPick?: (asset: AssetData) => void;
  storyId?: string;
}) {
  const assets = useAssets(p.id),
    q = useQueryClient(),
    base = `/projects/${p.id}`;
  const comps = useQuery({
    queryKey: ["compositions", p.id],
    queryFn: () => api<CompositionView[]>(base + "/compositions"),
  });
  const [filter, setFilter] = useState("All"),
    [capture, setCapture] = useState(false),
    [create, setCreate] = useState(false),
    [studio, setStudio] = useState(""),
    [source, setSource] = useState(""),
    [second, setSecond] = useState(""),
    [preset, setPreset] = useState("showcase"),
    [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const data = new FormData();
      data.append("file", file);
      const response = await fetch("/api" + base + "/assets", {
        method: "POST",
        body: data,
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error.message);
      setSource(result.sha);
      await q.invalidateQueries({ queryKey: ["assets", p.id] });
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const newImage = async () => {
    setBusy(true);
    try {
      const result = await api<CompositionView>(
        base + "/compositions",
        "POST",
        {
          preset,
          sources: [source, ...(second ? [second] : [])],
          ...(storyId ? { storyId } : {}),
        },
      );
      setCreate(false);
      setStudio(result.composition.id);
      await q.invalidateQueries({ queryKey: ["compositions", p.id] });
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const visible =
    assets.data?.filter(
      (a) =>
        a.mime.startsWith("image/") &&
        a.kind !== "contact_sheet" &&
        (filter === "All" ||
          a.kind ===
            (
              {
                Screenshots: "screenshot",
                Uploads: "upload",
                Images: "image_render",
              } as Record<string, string>
            )[filter]),
    ) || [];
  return (
    <section className="media-library">
      <div className="section-heading">
        <h2>{onPick ? "Choose an image" : "Media"}</h2>
        <div className="actions">
          <Button
            onClick={() => {
              setSource(
                source ||
                  assets.data?.find(
                    (a) =>
                      a.mime.startsWith("image/") && a.kind !== "contact_sheet",
                  )?.sha ||
                  "",
              );
              setCreate(true);
            }}
          >
            {onPick ? "New image from screenshot" : "New image"}
          </Button>
          <Button onClick={() => setCapture(true)}>Capture</Button>
          <label className="button secondary upload-button">
            {busy ? "Uploading…" : "Upload"}
            <input
              aria-label="Upload image"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(e) => {
                if (e.target.files?.[0]) void upload(e.target.files[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {!onPick && <VideoLauncher p={p} />}
      <div className="actions media-filters">
        {["All", "Screenshots", "Uploads", "Images"].map((f) => (
          <Button
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f}
          </Button>
        ))}
      </div>
      {assets.error && <ErrorBox error={assets.error} />}
      {!assets.data?.length && (
        <p className="muted">
          Upload a screenshot or capture a page to start an image.
        </p>
      )}
      <div className="media-grid">
        {visible.map((a) => (
          <article className="media-tile" key={a.sha}>
            <img
              src={assetUrl(p.id, a.sha) + "/thumbnail"}
              alt={
                a.provenance.type === "upload"
                  ? a.provenance.filename
                  : a.kind === "screenshot"
                    ? "Captured screenshot"
                    : "Rendered image"
              }
            />
            <small>
              {a.kind.replace("_", " ")} · {a.width} × {a.height}
            </small>
            <div className="actions">
              {onPick ? (
                <Button onClick={() => onPick(a)}>Attach image</Button>
              ) : (
                <Button
                  onClick={() => {
                    setSource(a.sha);
                    setCreate(true);
                  }}
                >
                  Use in new image
                </Button>
              )}
              <a
                href={assetUrl(p.id, a.sha)}
                download={`${a.sha}.${a.mime === "image/jpeg" ? "jpg" : a.mime.split("/")[1]}`}
              >
                Download
              </a>
            </div>
          </article>
        ))}
        {(filter === "All" || filter === "Images") &&
          comps.data?.map((c) => (
            <article className="media-tile" key={c.composition.id}>
              <img
                src={`/api${base}/compositions/${c.composition.id}/thumbnail?commit=${c.commit}`}
                alt={c.composition.title}
              />
              <strong>{c.composition.title}</strong>
              <Button onClick={() => setStudio(c.composition.id)}>
                Open image
              </Button>
            </article>
          ))}
      </div>
      {capture && <CaptureDialog p={p} onClose={() => setCapture(false)} />}
      {create && (
        <Dialog
          open
          title="New image"
          onOpenChange={(v) => !v && setCreate(false)}
        >
          <div className="image-create">
            <SourcePicker
              label="Source screenshot"
              project={p.id}
              assets={assets.data}
              value={source}
              onChange={setSource}
            />
            <div className="field">
              <span id="new-image-preset">Preset</span>
              <div
                className="preset-grid"
                role="radiogroup"
                aria-labelledby="new-image-preset"
              >
                {["showcase", "minimal", "launch", "technical", "comparison"].map((v) => (
                  <button
                    type="button"
                    key={v}
                    role="radio"
                    aria-checked={preset === v}
                    aria-pressed={preset === v}
                    onClick={() => setPreset(v)}
                  >
                    <img src={`/presets/${v}.svg`} alt="" />
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {preset === "comparison" && (
              <SourcePicker
                label="After screenshot"
                project={p.id}
                assets={assets.data}
                value={second || source}
                onChange={setSecond}
              />
            )}
            <Button disabled={!source || busy} onClick={() => void newImage()}>
              Create image
            </Button>
          </div>
        </Dialog>
      )}
      {studio && (
        <ImageStudio
          p={p}
          id={studio}
          onClose={() => {
            setStudio("");
            void q.invalidateQueries();
          }}
        />
      )}
    </section>
  );
}
export function CaptureDialog({
  p,
  onClose,
}: {
  p: ProjectRow;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("http://localhost:3000"),
    [viewport, setViewport] = useState("1440x900"),
    [fullPage, setFullPage] = useState(false),
    [selector, setSelector] = useState(""),
    [waitFor, setWaitFor] = useState("networkidle"),
    [waitSelector, setWaitSelector] = useState(""),
    [delay, setDelay] = useState(1000),
    [steps, setSteps] = useState("[]"),
    [description, setDescription] = useState(""),
    [agent, setAgent] = useState<"claude" | "codex">("claude"),
    [describeId, setDescribeId] = useState(""),
    [captureId, setCaptureId] = useState(""),
    [approved, setApproved] = useState(false),
    [generated, setGenerated] = useState(false),
    [checks, setChecks] = useState<StepCheck[] | undefined>(),
    [error, setError] = useState("");
  const jobs = useJobs(),
    q = useQueryClient(),
    describeJob = jobs.data?.find((j) => j.id === describeId),
    captureJob = jobs.data?.find((j) => j.id === captureId);
  useEffect(() => {
    if (describeJob?.status === "succeeded") {
      setSteps(JSON.stringify(describeJob.result.steps, null, 2));
      setChecks(describeJob.result.checks);
      setGenerated(true);
      setApproved(false);
    }
  }, [describeJob?.status, describeId]);
  useEffect(() => {
    if (captureJob?.status === "succeeded") {
      void q.invalidateQueries({ queryKey: ["assets", p.id] });
      onClose();
    }
  }, [captureJob?.status]);
  const run = async () => {
    try {
      setError("");
      const input = CaptureInput.parse({
        url,
        viewport,
        fullPage,
        selector: selector || undefined,
        waitFor,
        waitSelector: waitSelector || undefined,
        delay,
        steps: JSON.parse(steps),
      });
      if (generated && !approved)
        throw Error("Review and approve the generated steps before capturing");
      const job = await api<JobView>(
        `/projects/${p.id}/capture`,
        "POST",
        input,
      );
      setCaptureId(job.id);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Dialog
      open
      sheet
      title="Capture screenshot"
      onOpenChange={(v) => !v && onClose()}
    >
      <div className="capture-form">
        <label className="field">
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          Viewport
          <select
            value={viewport}
            onChange={(e) => setViewport(e.target.value)}
          >
            {["1440x900", "1280x800", "390x844"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <p className="muted">
          DPR 2 · A fresh browser context with no saved cookies.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={fullPage}
            onChange={(e) => setFullPage(e.target.checked)}
          />
          Full page
        </label>
        <label className="field">
          Element selector (optional)
          <input
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
          />
        </label>
        <label className="field">
          Wait for
          <select value={waitFor} onChange={(e) => setWaitFor(e.target.value)}>
            <option value="networkidle">Network idle</option>
            <option value="selector">Selector</option>
            <option value="delay">Delay</option>
          </select>
        </label>
        {waitFor === "selector" && (
          <label className="field">
            Wait selector
            <input
              value={waitSelector}
              onChange={(e) => setWaitSelector(e.target.value)}
            />
          </label>
        )}
        {waitFor === "delay" && (
          <label className="field">
            Delay (ms)
            <input
              type="number"
              min={0}
              max={30000}
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
            />
          </label>
        )}
        <label className="field">
          Describe steps
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="actions">
          <AgentPicker
            p={p}
            task="image.steps"
            value={agent}
            onChange={setAgent}
          />
          <Button
            disabled={
              !description ||
              ["running", "queued"].includes(describeJob?.status || "")
            }
            onClick={() =>
              void api<JobView>(`/projects/${p.id}/capture/describe`, "POST", {
                provider: agent,
                description,
                url,
                viewport,
              })
                .then((j) => {
                  setDescribeId(j.id);
                  setApproved(false);
                })
                .catch(message)
            }
          >
            Describe steps
          </Button>
        </div>
        <JobFeedback job={describeJob} />
        <StepCheckSummary checks={checks} />
        <CaptureSteps
          steps={steps}
          checks={checks}
          onChange={(v) => {
            setSteps(v);
            setChecks(undefined);
            setApproved(false);
          }}
        />
        <label className="field">
          Steps JSON
          <textarea
            className="mono"
            rows={7}
            value={steps}
            onChange={(e) => {
              setSteps(e.target.value);
              setChecks(undefined);
              setApproved(false);
            }}
          />
        </label>
        <p className="muted">
          Actions: click, type, scroll, hover, wait, press. Use selector, text,
          value or ms as needed.
        </p>
        {generated && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I reviewed and approve these steps
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <JobFeedback job={captureJob} />
        <Button
          variant="default"
          disabled={
            (generated && !approved) ||
            ["running", "queued"].includes(captureJob?.status || "")
          }
          onClick={() => void run()}
        >
          Run capture
        </Button>
      </div>
    </Dialog>
  );
}

/** Describes an image asset by where it came from: capture URL + date, or upload filename. */
export function assetLabel(a: AssetData) {
  const date = new Date(a.createdAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
  if (a.provenance.type === "capture") {
    let where = a.provenance.url;
    try {
      const u = new URL(a.provenance.url);
      where = u.host + (u.pathname === "/" ? "" : u.pathname);
    } catch {}
    return `${where} · ${date}`;
  }
  if (a.provenance.type === "upload")
    return `${a.provenance.filename} · ${date}`;
  if (a.kind === "image_render") return `Exported image · ${date}`;
  if (a.provenance.type === "video_still") return `Video still · ${date}`;
  return `${a.kind.replace("_", " ")} · ${date}`;
}
function SourcePicker({
  label,
  project,
  assets,
  value,
  onChange,
}: {
  label: string;
  project: string;
  assets?: AssetData[];
  value: string;
  onChange: (sha: string) => void;
}) {
  const labelId = useId();
  const images =
    assets?.filter(
      (a) => a.mime.startsWith("image/") && a.kind !== "contact_sheet",
    ) || [];
  return (
    <div className="field">
      <span id={labelId}>{label}</span>
      {!images.length && (
        <p className="muted">Capture or upload a screenshot first.</p>
      )}
      <div className="source-grid" role="radiogroup" aria-labelledby={labelId}>
        {images.map((a) => (
          <button
            type="button"
            key={a.sha}
            role="radio"
            aria-checked={value === a.sha}
            aria-pressed={value === a.sha}
            onClick={() => onChange(a.sha)}
            title={
              a.provenance.type === "capture" ? a.provenance.url : undefined
            }
          >
            <img src={assetUrl(project, a.sha) + "/thumbnail"} alt="" />
            <span>{assetLabel(a)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
