import type { ProjectRow } from "@bip/shared";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message, useRefresh } from "../../components/workspace";
export function Locate({
  project,
  onClose,
}: {
  project: ProjectRow | null;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const refresh = useRefresh();
  return (
    <Dialog
      open={!!project}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Locate folder"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (project)
            void api(`/projects/${project.id}/locate`, "POST", { path })
              .then(() => {
                refresh();
                onClose();
              })
              .catch(message);
        }}
      >
        <label className="field">
          Repository path
          <input
            required
            className="mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <div className="dialog-footer">
          <Button variant="default">Locate folder</Button>
        </div>
      </form>
    </Dialog>
  );
}
