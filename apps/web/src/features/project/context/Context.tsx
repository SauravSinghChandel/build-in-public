import type { ProjectRow } from "@bip/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../../api";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import {
  ErrorBox,
  Loading,
  message,
  useRefresh,
} from "../../../components/workspace";
import { Summary } from "../../studio/Summary";
export function Context({ p }: { p: ProjectRow }) {
  const query = useQuery({
    queryKey: ["context", p.id],
    queryFn: () =>
      api<{ shareable: string; private: string }>(`/projects/${p.id}/context`),
  });
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return query.data ? (
    <ContextEditors key={p.id} p={p} initial={query.data} />
  ) : null;
}
function ContextEditors({
  p,
  initial,
}: {
  p: ProjectRow;
  initial: { shareable: string; private: string };
}) {
  const [notes, setNotes] = useState(initial),
    [status, setStatus] = useState("Saved");
  const latest = useRef(notes);
  const saved = useRef(JSON.stringify(initial));
  const chain = useRef(Promise.resolve());
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  const save = (value: typeof notes) => {
    const serialized = JSON.stringify(value);
    if (serialized === saved.current) return;
    setStatus("Saving…");
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        try {
          await api(`/projects/${p.id}/context`, "PUT", value);
          saved.current = serialized;
          queryClient.setQueryData(["context", p.id], value);
          void queryClient.invalidateQueries({ queryKey: ["project", p.id] });
          if (JSON.stringify(latest.current) === serialized) setStatus("Saved");
        } catch (e) {
          setStatus("Could not save");
          message(e);
        }
      });
  };
  useEffect(() => {
    latest.current = notes;
    if (JSON.stringify(notes) === saved.current) {
      setStatus("Saved");
      return;
    }
    setStatus("Unsaved");
    const timer = setTimeout(() => save(notes), 800);
    return () => clearTimeout(timer);
  }, [notes]);
  useEffect(() => {
    return () => {
      save(latest.current);
    };
  }, []);
  return (
    <>
      <Summary p={p} />
      <div className="section-heading">
        <h2>Project context</h2>
        <span role="status" className="muted small">
          {p.readOnly ? "Read-only: another instance holds the lock" : status}
        </span>
      </div>
      <div className="editors">
        <label className="field">
          Shareable notes<span className="muted small mono">context.md</span>
          <textarea
            disabled={p.readOnly}
            aria-label="Shareable notes"
            value={notes.shareable}
            onChange={(e) => setNotes({ ...notes, shareable: e.target.value })}
          />
        </label>
        <label className="field">
          Private notes
          <span className="muted small">
            Never included in posts. Agents use it only to know what to avoid.
          </span>
          <textarea
            disabled={p.readOnly}
            aria-label="Private notes"
            value={notes.private}
            onChange={(e) => setNotes({ ...notes, private: e.target.value })}
          />
        </label>
      </div>
      <div className="context-options">
        <div className="switch-row">
          <Switch
            id="commit-context"
            checked={p.commitContext}
            disabled={p.readOnly}
            onCheckedChange={(enabled) =>
              void api(`/projects/${p.id}/commit-context`, "POST", { enabled })
                .then(refresh)
                .catch(message)
            }
          />
          <div>
            <label htmlFor="commit-context">
              Commit context.md to this repository
            </label>
            <p className="muted small">
              Only context.md and .bip/.gitignore become visible to Git. Private
              notes stay ignored. Shared worktree exclude rules may affect other
              checkouts.
            </p>
          </div>
        </div>
        <div className="list-toolbar">
          <span className="muted mono">
            .bip/ · {(p.bipSize / 1024).toFixed(1)} KB
          </span>
          <Button
            onClick={() =>
              void api(`/projects/${p.id}/backup`, "POST")
                .then(() => toast.success("Backup saved"))
                .catch(message)
            }
          >
            Back up now
          </Button>
        </div>
        <p className="muted small">
          Deleting the repository or running git clean -fdx removes .bip/. Keep
          a backup of your notes.
        </p>
      </div>
    </>
  );
}
