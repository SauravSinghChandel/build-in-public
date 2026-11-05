import type { ProjectRow } from "@bip/shared";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../api";
import { Path } from "../../components/Path";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message, useRefresh } from "../../components/workspace";
import { Locate } from "../../features/projects/Locate";
export function ProjectSettings({ p }: { p: ProjectRow }) {
  const [name, setName] = useState(p.name),
    [locate, setLocate] = useState(false),
    [remove, setRemove] = useState<"untrack" | "delete" | null>(null),
    [confirmName, setConfirmName] = useState("");
  const [tone, setTone] = useState(p.settings.tone || "Casual"),
    [audience, setAudience] = useState(p.settings.audience || ""),
    [allowEmoji, setAllowEmoji] = useState(p.settings.allowEmoji || false);
  const refresh = useRefresh();
  const navigate = useNavigate();
  return (
    <div className="settings-content">
      <h2>Project settings</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void api(`/projects/${p.id}`, "PATCH", {
            name,
            settings: { ...p.settings, tone, audience, allowEmoji },
          })
            .then(() => {
              refresh();
              toast.success("Project updated");
            })
            .catch(message);
        }}
      >
        <label className="field">
          Display name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="field">
          Default tone
          <select value={tone} onChange={(e) => setTone(e.target.value)}>
            {["Casual", "Technical", "Professional", "Playful"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Audience
          <input
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            placeholder="Who are you writing for?"
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allowEmoji}
            onChange={(e) => setAllowEmoji(e.target.checked)}
          />
          Allow emoji in drafts
        </label>
        <Button>Save settings</Button>
      </form>
      <section>
        <h2>Scan options</h2>
        <p className="muted">Scan depth is managed in Settings → Folders.</p>
        <p className="mono muted">
          <Path value={p.path} />
        </p>
        <Button onClick={() => setLocate(true)}>Locate folder</Button>
      </section>
      <section className="danger-zone">
        <h2>Project data</h2>
        <p className="muted">
          Stop tracking leaves .bip/ in the repository. Deleting data removes
          its notes and metadata.
        </p>
        <div className="actions">
          <Button onClick={() => setRemove("untrack")}>Stop tracking</Button>
          <Button variant="destructive" onClick={() => setRemove("delete")}>
            Delete Build in Public data
          </Button>
        </div>
      </section>
      <Locate project={locate ? p : null} onClose={() => setLocate(false)} />
      <Dialog
        open={!!remove}
        onOpenChange={(o) => {
          if (!o) setRemove(null);
        }}
        title={
          remove === "delete"
            ? "Delete Build in Public data"
            : "Stop tracking this project"
        }
      >
        <p>
          {remove === "delete"
            ? "This permanently removes the .bip folder. Type the project name to confirm."
            : "Your .bip folder and notes will stay in the repository."}
        </p>
        {remove === "delete" && (
          <label className="field">
            Project name
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={p.name}
            />
          </label>
        )}
        <div className="dialog-footer">
          <Button onClick={() => setRemove(null)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={remove === "delete" && confirmName !== p.name}
            onClick={() =>
              void api(
                `/projects/${p.id}/${remove === "delete" ? "bip-data" : "untrack"}`,
                remove === "delete" ? "DELETE" : "POST",
                remove === "delete" ? { confirmName } : undefined,
              )
                .then(() => {
                  refresh();
                  void navigate({ to: "/" });
                })
                .catch(message)
            }
          >
            {remove === "delete" ? "Delete data" : "Stop tracking"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
