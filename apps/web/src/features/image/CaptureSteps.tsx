import { CaptureStep, type StepCheck } from "@bip/shared";
import { Button } from "../../components/ui/button";
type Step = ReturnType<typeof CaptureStep.parse>;
export function CaptureSteps({
  steps,
  onChange,
  video = false,
  checks,
}: {
  steps: string;
  onChange: (s: string) => void;
  video?: boolean;
  /** Dry-run results for generated steps (same order); omitted once the user edits. */
  checks?: StepCheck[];
}) {
  let rows: Partial<Step>[] = [];
  try {
    const v = JSON.parse(steps);
    if (
      Array.isArray(v) &&
      v.length <= 50 &&
      v.every((s) => s && typeof s === "object")
    )
      rows = v;
  } catch {}
  const edit = (rows: Partial<Step>[]) =>
    onChange(JSON.stringify(rows, null, 2));
  const patch = (i: number, p: Partial<Step>) =>
    edit(rows.map((s, n) => (i === n ? { ...s, ...p } : s)));
  return (
    <div className="capture-step-editor" aria-label="Manual steps editor">
      {rows.map((s, i) => (
        <div
          className={`capture-step${checks?.[i] && !["ok", "none"].includes(checks[i].status) ? " flagged" : ""}`}
          key={i}
        >
          <select
            aria-label={`Step ${i + 1} action`}
            value={s.action}
            onChange={(e) =>
              edit(
                rows.map((s, n) =>
                  i === n
                    ? {
                        action: e.target.value as Step["action"],
                        ...(["pause", "wait"].includes(e.target.value)
                          ? { ms: 1000 }
                          : e.target.value === "scrollTo"
                            ? { y: 0, durationMs: 800 }
                            : {}),
                      }
                    : s,
                ),
              )
            }
          >
            {[
              "click",
              "type",
              "scroll",
              "hover",
              "wait",
              "press",
              ...(video ? ["pause", "scrollTo"] : []),
            ].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          {["click", "type", "hover", "scrollTo"].includes(s.action || "") && (
            <input
              aria-label={`Step ${i + 1} selector`}
              placeholder="Selector"
              value={s.selector || ""}
              onChange={(e) => patch(i, { selector: e.target.value })}
            />
          )}
          {s.action === "type" && (
            <input
              aria-label={`Step ${i + 1} text`}
              placeholder="Text"
              value={s.text || ""}
              onChange={(e) => patch(i, { text: e.target.value })}
            />
          )}
          {["wait", "pause"].includes(s.action || "") && (
            <input
              aria-label={`Step ${i + 1} milliseconds`}
              type="number"
              min={0}
              max={30000}
              value={s.ms ?? 1000}
              onChange={(e) => patch(i, { ms: Number(e.target.value) })}
            />
          )}
          {["scroll", "press"].includes(s.action || "") && (
            <input
              aria-label={`Step ${i + 1} value`}
              placeholder={s.action === "press" ? "Enter" : "Scroll pixels"}
              value={s.value ?? ""}
              onChange={(e) =>
                patch(i, {
                  value:
                    s.action === "scroll"
                      ? Number(e.target.value)
                      : e.target.value,
                })
              }
            />
          )}
          {s.action === "scrollTo" && (
            <>
              <input
                aria-label={`Step ${i + 1} y`}
                type="number"
                placeholder="Y (if no selector)"
                value={s.y ?? ""}
                onChange={(e) => patch(i, { y: Number(e.target.value) })}
              />
              <input
                aria-label={`Step ${i + 1} duration`}
                type="number"
                min={1}
                max={30000}
                value={s.durationMs ?? 800}
                onChange={(e) =>
                  patch(i, { durationMs: Number(e.target.value) })
                }
              />
            </>
          )}
          {checks?.[i] && checks[i].status !== "none" && (
            <span
              className={`step-check ${checks[i].status}`}
              role="note"
              aria-label={`Step ${i + 1} check`}
              title={checks[i].message}
            >
              {checks[i].status === "ok"
                ? "✓ Found on page"
                : checks[i].status === "missing"
                  ? "Not found on page"
                  : checks[i].status === "ambiguous"
                    ? `Matches ${checks[i].count} elements`
                    : "Invalid selector"}
            </span>
          )}
          <Button
            aria-label={`Remove step ${i + 1}`}
            onClick={() => edit(rows.filter((_, n) => n !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        disabled={rows.length >= 50}
        onClick={() =>
          edit([...rows, { action: video ? "pause" : "wait", ms: 1000 }])
        }
      >
        Add step
      </Button>
    </div>
  );
}

/** One-line summary above generated steps: how many were found on the live page. */
export function StepCheckSummary({ checks }: { checks?: StepCheck[] }) {
  if (!checks) return null;
  const checked = checks.filter((c) => c.status !== "none"),
    flagged = checked.filter((c) => c.status !== "ok").length;
  if (!checked.length) return null;
  return (
    <p
      className={flagged ? "step-summary flagged" : "step-summary"}
      role="status"
    >
      {flagged
        ? `${flagged} of ${checked.length} selectors need attention. Fix the marked steps before approving.`
        : `All ${checked.length} selectors were found on the page.`}
    </p>
  );
}
