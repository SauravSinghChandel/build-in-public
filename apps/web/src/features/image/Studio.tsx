import { useEffect, useRef, useState } from "react";
import { Dialog as Primitive } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  imageSizes,
  type CompositionData,
  type CompositionView,
  type ProjectRow,
} from "@bip/shared";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { ErrorBox, message } from "../../components/workspace";
import { AgentPicker, JobFeedback, useJobs } from "../studio/jobs";
import { assetLabel, assetUrl, useAssets } from "./Media";
export function ImageStudio({
  p,
  id,
  onClose,
}: {
  p: ProjectRow;
  id: string;
  onClose: () => void;
}) {
  const base = `/projects/${p.id}/compositions/${id}`,
    q = useQueryClient(),
    assets = useAssets(p.id),
    jobs = useJobs();
  const query = useQuery({
    queryKey: ["composition", p.id, id],
    queryFn: () => api<CompositionView>(base),
  });
  const [draft, setDraft] = useState<CompositionData>(),
    [view, setView] = useState<CompositionView>(),
    [zoom, setZoom] = useState<"fit" | "100%">("fit"),
    [scale, setScale] = useState(0.5),
    [instruction, setInstruction] = useState(""),
    [agent, setAgent] = useState<"claude" | "codex">("claude"),
    [format, setFormat] = useState("png"),
    [exportSize, setExportSize] = useState("current"),
    [saving, setSaving] = useState("Saved"),
    [historical, setHistorical] = useState(false),
    [busy, setBusy] = useState(false),
    [fidelity, setFidelity] = useState<{ pass: boolean; errors: string[] }>();
  const stage = useRef<HTMLDivElement>(null),
    latest = useRef(draft),
    saved = useRef(""),
    chain = useRef(Promise.resolve()),
    undo = useRef<string[]>([]),
    cursor = useRef(0);
  latest.current = draft;
  const active = jobs.data?.find(
    (j) =>
      j.type === "image.edit" &&
      j.payload.compositionId === id &&
      ["queued", "running"].includes(j.status),
  );
  const editJob = jobs.data?.find(
    (j) => j.type === "image.edit" && j.payload.compositionId === id,
  );
  const adopt = (v: CompositionView, reset = true) => {
    setView(v);
    setDraft(v.composition);
    saved.current = JSON.stringify(v.composition);
    setSaving("Saved");
    setHistorical(false);
    if (reset) {
      undo.current = v.revisions.map((r) => r.commit);
      cursor.current = undo.current.length - 1;
    }
    void q.invalidateQueries({ queryKey: ["compositions", p.id] });
  };
  useEffect(() => {
    if (query.data && !draft) adopt(query.data);
  }, [query.data]);
  useEffect(() => {
    if (editJob?.status === "succeeded")
      void api<CompositionView>(base)
        .then((v) => adopt(v))
        .catch(message);
  }, [editJob?.id, editJob?.status]);
  const save = async () => {
    const value = latest.current;
    if (!value || JSON.stringify(value) === saved.current) return chain.current;
    const text = JSON.stringify(value);
    setSaving("Saving…");
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        const {
          title,
          preset,
          width,
          height,
          slots,
          sources,
          allowScreenshotEdits,
        } = value;
        const result = await api<CompositionView>(base, "PATCH", {
          title,
          preset,
          width,
          height,
          slots,
          sources,
          allowScreenshotEdits,
        });
        saved.current = JSON.stringify(result.composition);
        if (JSON.stringify(latest.current) === text) {
          latest.current = result.composition;
          setDraft(result.composition);
        }
        setView(result);
        setSaving("Saved");
        undo.current = result.revisions.map((r) => r.commit);
        cursor.current = undo.current.length - 1;
        setHistorical(false);
      });
    return chain.current.catch((e) => {
      setSaving("Could not save");
      message(e);
      throw e;
    });
  };
  useEffect(() => {
    if (!draft || JSON.stringify(draft) === saved.current) return;
    setSaving("Unsaved");
    const timer = setTimeout(() => void save().catch(() => {}), 1500);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    if (!view) return;
    setFidelity(undefined);
    const controller = new AbortController();
    fetch("/api" + base + "/check?commit=" + view.commit, {
      signal: controller.signal,
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error.message);
        setFidelity(data);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setFidelity({ pass: false, errors: [e.message] });
      });
    return () => controller.abort();
  }, [view?.commit]);
  useEffect(() => {
    const el = stage.current;
    if (!el || !draft) return;
    const resize = () =>
      setScale(
        Math.min(
          (el.clientWidth - 40) / draft.width,
          (el.clientHeight - 40) / draft.height,
          1,
        ),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft?.width, draft?.height, !!view]);
  const restore = async (commit: string, reset = true) => {
    setBusy(true);
    try {
      await save();
      adopt(
        await api<CompositionView>(base + "/restore", "POST", { commit }),
        reset,
      );
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      if (e.key.toLowerCase() === "f") {
        setZoom("fit");
        e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const next = cursor.current + (e.shiftKey ? 1 : -1);
        if (next >= 0 && next < undo.current.length && !busy) {
          cursor.current = next;
          void restore(undo.current[next], false);
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, draft]);
  const change = (patch: Partial<CompositionData>) =>
    setDraft((c) => (c ? { ...c, ...patch } : c));
  const slot = <K extends keyof CompositionData["slots"]>(
    key: K,
    value: CompositionData["slots"][K],
  ) => setDraft((c) => (c ? { ...c, slots: { ...c.slots, [key]: value } } : c));
  const exportImage = async () => {
    setBusy(true);
    try {
      await save();
      const response = await fetch("/api" + base + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          ...(historical ? { commit: view?.commit } : {}),
          ...(exportSize !== "current" ? { size: exportSize } : {}),
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw Error(data.error.message);
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `${draft?.title || "image"}.${format === "png" ? "png" : "jpg"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await q.invalidateQueries({ queryKey: ["assets", p.id] });
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const presetPreview = (name: string) => `/presets/${name}.svg`;
  return (
    <Primitive.Root open>
      <Primitive.Portal>
        <Primitive.Content className="image-studio" aria-label="Image Studio">
          <Primitive.Title className="sr-only">Image Studio</Primitive.Title>
          <Primitive.Description className="sr-only">
            Edit and export your image
          </Primitive.Description>
          <div className="studio-top">
            <label className="sr-only" htmlFor="image-title">
              Image title
            </label>
            <input
              id="image-title"
              disabled={historical || !!active || busy}
              value={draft?.title || ""}
              onChange={(e) => change({ title: e.target.value })}
            />
            <span
              className={fidelity?.pass ? "ok" : "muted"}
              title={fidelity?.errors.join("\n")}
            >
              {draft?.allowScreenshotEdits
                ? "Screenshot edits allowed"
                : fidelity
                  ? fidelity.pass
                    ? "✓ Screenshot unchanged"
                    : "⚠ Check image fidelity"
                  : "Checking screenshot…"}
            </span>
            <small aria-live="polite">{saving}</small>
            <label>
              Format{" "}
              <select
                aria-label="Export format"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
            </label>
            <select
              aria-label="Export size"
              value={exportSize}
              onChange={(e) => setExportSize(e.target.value)}
            >
              <option value="current">Current size</option>
              {Object.keys(imageSizes).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button
              disabled={busy || !!active || saving === "Could not save"}
              onClick={() => void exportImage()}
            >
              Export
            </Button>
            <Button
              onClick={() => {
                void save()
                  .then(onClose)
                  .catch(() => {});
              }}
            >
              Close
            </Button>
          </div>
          {query.error && <ErrorBox error={query.error} />}
          {draft && view && (
            <>
              <div className="studio-body">
                <aside className="studio-left">
                  <h2>Sources</h2>
                  {draft.sources.map((sha, i) => (
                    <label className="field" key={i}>
                      <img
                        className="source-thumb"
                        src={assetUrl(p.id, sha) + "/thumbnail"}
                        alt={`Source ${i + 1}`}
                      />
                      <span>Swap source {i + 1}</span>
                      <select
                        value={sha}
                        disabled={historical || !!active}
                        onChange={(e) =>
                          change({
                            sources: draft.sources.map((s, n) =>
                              n === i ? e.target.value : s,
                            ),
                          })
                        }
                      >
                        {assets.data
                          ?.filter(
                            (a) =>
                              a.mime.startsWith("image/") &&
                              a.kind !== "contact_sheet",
                          )
                          .map((a) => (
                            <option key={a.sha} value={a.sha}>
                              {assetLabel(a)}
                            </option>
                          ))}
                      </select>
                    </label>
                  ))}
                  <h2>Preset</h2>
                  <div className="preset-grid">
                    {["minimal", "launch", "technical", "comparison"].map(
                      (name) => (
                        <button
                          key={name}
                          aria-pressed={draft.preset === name}
                          disabled={historical || !!active}
                          onClick={() =>
                            change({
                              preset: name as CompositionData["preset"],
                            })
                          }
                        >
                          <img src={presetPreview(name)} alt="" />
                          {name}
                        </button>
                      ),
                    )}
                  </div>
                  <label className="field">
                    Canvas size
                    <select
                      aria-label="Canvas size"
                      value={
                        Object.entries(imageSizes).find(
                          ([, v]) =>
                            v[0] === draft.width && v[1] === draft.height,
                        )?.[0] || "x"
                      }
                      disabled={historical || !!active}
                      onChange={(e) => {
                        const [width, height] =
                          imageSizes[e.target.value as keyof typeof imageSizes];
                        change({ width, height });
                      }}
                    >
                      {Object.entries(imageSizes).map(([key, [w, h]]) => (
                        <option value={key} key={key}>
                          {key === "x"
                            ? "X"
                            : key === "linkedin"
                              ? "LinkedIn"
                              : key}{" "}
                          · {w} × {h}
                        </option>
                      ))}
                    </select>
                  </label>
                </aside>
                <main className="studio-canvas">
                  <div className="canvas-controls">
                    <Button
                      aria-pressed={zoom === "fit"}
                      onClick={() => setZoom("fit")}
                    >
                      Fit
                    </Button>
                    <Button
                      aria-pressed={zoom === "100%"}
                      onClick={() => setZoom("100%")}
                    >
                      100%
                    </Button>
                    <span>
                      {draft.width} × {draft.height}
                    </span>
                    {historical && <span>Previewing an earlier revision</span>}
                  </div>
                  <div ref={stage} className="canvas-stage">
                    <div
                      style={{
                        width: draft.width * (zoom === "fit" ? scale : 1),
                        height: draft.height * (zoom === "fit" ? scale : 1),
                        flexShrink: 0,
                      }}
                    >
                      <iframe
                        title="Image preview"
                        {...{ credentialless: true }}
                        sandbox="allow-scripts"
                        src={view.previewUrl}
                        width={draft.width}
                        height={draft.height}
                        style={{
                          transform: `scale(${zoom === "fit" ? scale : 1})`,
                          transformOrigin: "top left",
                          border: 0,
                          background: "#15171c",
                        }}
                      />
                    </div>
                  </div>
                  {fidelity && !fidelity.pass && (
                    <div className="fidelity-errors" role="alert">
                      {fidelity.errors.map((e, i) => (
                        <p key={i}>{e}</p>
                      ))}
                    </div>
                  )}
                </main>
                <aside className="studio-right">
                  <h2>Image slots</h2>
                  <fieldset disabled={historical || !!active || busy}>
                    <label className="field">
                      Headline
                      <textarea
                        rows={2}
                        value={draft.slots.headline}
                        onChange={(e) => slot("headline", e.target.value)}
                      />
                    </label>
                    <label className="field">
                      Subhead
                      <textarea
                        rows={3}
                        value={draft.slots.subhead}
                        onChange={(e) => slot("subhead", e.target.value)}
                      />
                    </label>
                    <ColourInput
                      label="Accent colour"
                      value={draft.slots.accent}
                      onChange={(v) => slot("accent", v)}
                    />
                    <label className="field">
                      Background style
                      <select
                        value={draft.slots.background}
                        onChange={(e) =>
                          slot(
                            "background",
                            e.target
                              .value as CompositionData["slots"]["background"],
                          )
                        }
                      >
                        {["solid", "radial", "noise", "dominant"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      Frame style
                      <select
                        value={draft.slots.frame}
                        onChange={(e) =>
                          slot(
                            "frame",
                            e.target.value as CompositionData["slots"]["frame"],
                          )
                        }
                      >
                        {["none", "browser", "window", "phone"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      Padding
                      <input
                        type="range"
                        min={16}
                        max={120}
                        value={draft.slots.padding}
                        onChange={(e) =>
                          slot("padding", Number(e.target.value))
                        }
                      />
                    </label>
                    <label className="field">
                      Shadow strength
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={draft.slots.shadow}
                        onChange={(e) => slot("shadow", Number(e.target.value))}
                      />
                    </label>
                    {draft.preset === "technical" &&
                      [0, 1, 2].map((n) => (
                        <label className="field" key={n}>
                          Annotation {n + 1}
                          <input
                            value={draft.slots.annotations[n] || ""}
                            onChange={(e) =>
                              slot(
                                "annotations",
                                [0, 1, 2].map((i) =>
                                  i === n
                                    ? e.target.value
                                    : draft.slots.annotations[i] || "",
                                ),
                              )
                            }
                          />
                        </label>
                      ))}
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={draft.allowScreenshotEdits}
                        onChange={(e) =>
                          change({ allowScreenshotEdits: e.target.checked })
                        }
                      />
                      Allow edits to screenshot
                    </label>
                    <p className="muted small">
                      Permits visual changes. Source bytes must still match
                      their hash.
                    </p>
                  </fieldset>
                  <label className="field">
                    Instruction
                    <textarea
                      rows={3}
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="What would you change?"
                    />
                  </label>
                  <AgentPicker
                    p={p}
                    task="image.edit"
                    value={agent}
                    onChange={setAgent}
                  />
                  <Button
                    disabled={!instruction || !!active || historical || busy}
                    onClick={() =>
                      void save()
                        .then(() =>
                          api(base + "/edit", "POST", {
                            provider: agent,
                            instruction,
                          }),
                        )
                        .then(() => q.invalidateQueries({ queryKey: ["jobs"] }))
                        .catch(message)
                    }
                  >
                    Apply
                  </Button>
                  <JobFeedback job={editJob} />
                </aside>
              </div>
              <div className="studio-revisions" aria-label="Image revisions">
                {view.revisions.map((r, i) => (
                  <div className="studio-revision" key={r.commit}>
                    <button
                      aria-pressed={r.commit === view.commit}
                      onClick={() =>
                        void save()
                          .then(() =>
                            api<CompositionView>(base + "?commit=" + r.commit),
                          )
                          .then((v) => {
                            setView(v);
                            setDraft(v.composition);
                            saved.current = JSON.stringify(v.composition);
                            setHistorical(true);
                          })
                          .catch(message)
                      }
                    >
                      <img
                        src={"/api" + base + "/thumbnail?commit=" + r.commit}
                        alt={`Revision ${i + 1}`}
                      />
                      <span>Revision {i + 1}</span>
                      <small title={r.instruction}>{r.instruction}</small>
                    </button>
                    <Button
                      disabled={busy || !!active}
                      onClick={() => void restore(r.commit)}
                    >
                      Restore revision {i + 1}
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/** A visible swatch plus a hex field; only valid #rrggbb values are committed. */
function ColourInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="colour-input">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
        <input
          className="mono"
          aria-label={label}
          value={text}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value.trim();
            setText(next);
            const hex = next.startsWith("#") ? next : "#" + next;
            if (/^#[0-9a-fA-F]{6}$/.test(hex)) onChange(hex.toLowerCase());
          }}
          onBlur={() => setText(value)}
        />
      </div>
    </div>
  );
}
