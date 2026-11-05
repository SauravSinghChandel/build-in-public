import type { DiscoveredRepo } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "../../api";
import { Path } from "../../components/Path";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  ErrorBox,
  message,
  relative,
  useRefresh,
} from "../../components/workspace";
export function AddProjects({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [path, setPath] = useState(""),
    [depth, setDepth] = useState(2),
    [mode, setMode] = useState("folder"),
    [repos, setRepos] = useState<DiscoveredRepo[] | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const refresh = useRefresh();
  const dirs = useQuery({
    queryKey: ["dirs", path],
    queryFn: () => api<string[]>(`/fs/dirs?prefix=${encodeURIComponent(path)}`),
    enabled: open && path.length > 0,
  });
  useEffect(() => {
    if (open) {
      setRepos(null);
      setError(null);
      setSelected(new Set());
    }
  }, [open]);
  async function scan(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<DiscoveredRepo[]>("/scan", "POST", {
        root: path,
        depth: mode === "single" ? 1 : depth,
      });
      if (mode === "single" && !result.some((r) => r.path === path))
        throw Error("Choose a repository root");
      setRepos(
        mode === "single" ? result.filter((r) => r.path === path) : result,
      );
      setSelected(new Set());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function track() {
    setBusy(true);
    try {
      if (mode === "folder")
        await api("/tracked-dirs", "POST", { root: path, depth });
      await api("/projects", "POST", { paths: [...selected] });
      refresh();
      toast.success(`Tracking ${selected.size} projects`);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const [suggestion, setSuggestion] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add projects"
      description={
        repos
          ? "Choose the repositories you want to track."
          : "Choose a folder to find your Git repositories."
      }
    >
      {error != null && <ErrorBox error={error} />}{" "}
      {!repos ? (
        <>
          <div className="tabs">
            <button
              className={mode === "folder" ? "active" : ""}
              onClick={() => setMode("folder")}
            >
              Choose a folder
            </button>
            <button
              className={mode === "single" ? "active" : ""}
              onClick={() => setMode("single")}
            >
              Add a single repository
            </button>
          </div>
          <form onSubmit={(e) => void scan(e)}>
            <label className="field">
              {mode === "folder" ? "Folder path" : "Repository path"}
              <input
                className="mono"
                role="combobox"
                aria-expanded={suggestOpen}
                aria-controls="directories"
                aria-autocomplete="list"
                onFocus={() => setSuggestOpen(true)}
                onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                onKeyDown={(e) => {
                  const list = dirs.data || [];
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setSuggestOpen(true);
                    setSuggestion(
                      (n) =>
                        (n + (e.key === "ArrowDown" ? 1 : -1) + list.length) %
                        (list.length || 1),
                    );
                  }
                  if (
                    (e.key === "Tab" || e.key === "Enter") &&
                    suggestOpen &&
                    list[suggestion]
                  ) {
                    e.preventDefault();
                    setPath(list[suggestion] + "/");
                    setSuggestion(0);
                  }
                  if (e.key === "Escape") setSuggestOpen(false);
                }}
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setSuggestOpen(true);
                  setSuggestion(0);
                }}
                placeholder="~/projects"
                required
              />
              {suggestOpen && !!dirs.data?.length && (
                <div
                  id="directories"
                  role="listbox"
                  className="directory-popover"
                >
                  {dirs.data.map((p, i) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === suggestion}
                      key={p}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setPath(p + "/");
                        setSuggestOpen(false);
                      }}
                    >
                      <Path value={p} />
                    </button>
                  ))}
                </div>
              )}
            </label>
            {mode === "folder" && (
              <label className="field">
                Scan depth
                <select
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                >
                  {[1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="dialog-footer">
              <Button type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="default" disabled={busy}>
                {busy ? "Finding…" : "Find repositories"}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <div className="list-toolbar">
            <span>{repos.length} repositories found</span>
            <label>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={
                  repos.some((r) => !r.tracked && !r.invalid) &&
                  repos
                    .filter((r) => !r.tracked && !r.invalid)
                    .every((r) => selected.has(r.path))
                }
                onChange={(e) =>
                  setSelected(
                    new Set(
                      e.target.checked
                        ? repos
                            .filter((r) => !r.tracked && !r.invalid)
                            .map((r) => r.path)
                        : [],
                    ),
                  )
                }
              />{" "}
              Select all
            </label>
          </div>
          <div className="repo-picker">
            {repos.map((r) => (
              <label
                className={`repo-choice${r.invalid ? " invalid" : ""}`}
                key={r.path}
              >
                <input
                  type="checkbox"
                  checked={!r.invalid && (r.tracked || selected.has(r.path))}
                  disabled={r.tracked || r.invalid}
                  onChange={() => toggle(r.path)}
                />
                <span>
                  <strong>{r.name}</strong>
                  <span className="mono muted">
                    <Path value={r.path} />
                  </span>
                  {r.invalid && (
                    <span className="repo-invalid">
                      <span className="error">
                        Not a valid Git repository (.git is empty or broken)
                      </span>
                      {r.reason && r.fix && (
                        <span className="muted small">{r.reason}</span>
                      )}
                      {r.fix && (
                        <span className="repo-fix">
                          <code>{r.fix}</code>
                          <Button
                            onClick={(e) => {
                              e.preventDefault();
                              void navigator.clipboard
                                .writeText(r.fix!)
                                .then(() => toast.success("Fix copied"))
                                .catch(message);
                            }}
                          >
                            Copy fix
                          </Button>
                        </span>
                      )}
                    </span>
                  )}
                </span>
                <span className="mono muted">{r.branch}</span>
                <span className="muted">
                  {r.invalid
                    ? "Can't track"
                    : r.tracked
                      ? "Tracking"
                      : relative(r.lastCommitAt)}
                </span>
              </label>
            ))}
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setRepos(null)}>Back</Button>
            <Button
              variant="default"
              disabled={!selected.size || busy}
              onClick={() => void track()}
            >
              Track {selected.size} projects
            </Button>
          </div>
          <p className="muted small">
            Project data stays in .bip/. Back it up before using git clean -fdx
            or deleting a repository.
          </p>
        </>
      )}
    </Dialog>
  );
}
