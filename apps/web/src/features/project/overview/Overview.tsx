import type { Commit, ProjectRow, StoryView } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../../api";
import { Button } from "../../../components/ui/button";
import { CommitMenu } from "../../../components/ui/dropdown-menu";
import {
  Empty,
  ErrorBox,
  Loading,
  day,
  message,
  useRefresh,
} from "../../../components/workspace";
import { AnglesSheet } from "../../studio/Angles";
export function Overview({
  p,
  onContext,
}: {
  p: ProjectRow;
  onContext: () => void;
}) {
  const [angleOpen, setAngleOpen] = useState(false);
  const stories = useQuery({
    queryKey: ["stories", p.id],
    queryFn: () => api<StoryView[]>(`/projects/${p.id}/stories`),
  });
  const [limit, setLimit] = useState(50);
  const {
    data: commits,
    isPending,
    error,
  } = useQuery({
    queryKey: ["commits", p.id, limit],
    queryFn: async () => {
      const pages: Commit[] = [];
      for (let offset = 0; offset < limit; offset += 50)
        pages.push(
          ...(await api<Commit[]>(
            `/projects/${p.id}/commits?offset=${offset}&limit=50`,
          )),
        );
      return pages;
    },
  });
  const context = useQuery({
    queryKey: ["context", p.id],
    queryFn: () =>
      api<{ shareable: string; private: string }>(`/projects/${p.id}/context`),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [expanded, setExpanded] = useState<Set<string>>(new Set());
  const anchor = useRef(0);
  const refresh = useRefresh();
  let previous = "";
  function select(index: number, shift: boolean) {
    const sha = commits![index].sha;
    setSelected((old) => {
      const next = new Set(old);
      const value = !next.has(sha);
      for (
        let n = shift ? Math.min(anchor.current, index) : index;
        n <= (shift ? Math.max(anchor.current, index) : index);
        n++
      ) {
        if (value) next.add(commits![n].sha);
        else next.delete(commits![n].sha);
      }
      return next;
    });
    anchor.current = index;
  }
  return (
    <div className="overview">
      <section aria-label="Commit timeline">
        {p.markerLost && (
          <p className="error">
            The last shared commit changed. Showing activity after its saved
            date.
          </p>
        )}
        <div className="section-heading">
          <h2>Unshared work</h2>
          <span className="signal">{p.unsharedCount} commits</span>
        </div>
        {!p.lastSharedCommit && (
          <p className="muted intro">
            Nothing shared yet. Everything below is new.
          </p>
        )}
        {isPending ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : !commits?.length ? (
          <Empty title="No commits yet">
            <p>Your work will appear here after your first commit.</p>
          </Empty>
        ) : (
          <div className="timeline">
            {commits.map((c, i) => {
              const label = day(c.date);
              const newDay = label !== previous;
              previous = label;
              const unshared = i < p.unsharedCount;
              return (
                <Fragment key={c.sha}>
                  {newDay && <h3 className="day-heading">{label}</h3>}
                  {(c.sha === p.lastSharedCommit ||
                    (p.markerLost && i === p.unsharedCount)) && (
                    <div className="shared-marker">
                      Last shared · {day(p.lastSharedDate || c.date)}
                    </div>
                  )}
                  <article
                    className={`commit ${unshared ? "unshared" : ""} ${selected.has(c.sha) ? "selected" : ""}`}
                  >
                    <div className="commit-main">
                      <input
                        aria-label={`Select ${c.subject}`}
                        type="checkbox"
                        checked={selected.has(c.sha)}
                        onChange={() => {}}
                        onClick={(e) => select(i, e.shiftKey)}
                      />
                      <button
                        className="commit-subject"
                        aria-expanded={expanded.has(c.sha)}
                        onClick={() =>
                          setExpanded((s) => {
                            const n = new Set(s);
                            n.has(c.sha) ? n.delete(c.sha) : n.add(c.sha);
                            return n;
                          })
                        }
                      >
                        {expanded.has(c.sha) ? (
                          <ChevronDown />
                        ) : (
                          <ChevronRight />
                        )}
                        <span>
                          <span>{c.subject}</span>
                          <span className="commit-meta">
                            <code>{c.sha.slice(0, 7)}</code>
                            <span>
                              {c.authorEmail !== p.currentUserEmail &&
                              c.authorName !== p.currentUserName
                                ? c.authorName
                                : ""}
                            </span>
                            <span>
                              +{c.insertions} −{c.deletions}
                            </span>
                            <span>{c.files.length} files</span>
                          </span>
                        </span>
                      </button>
                      <CommitMenu
                        onMark={() =>
                          void api(`/projects/${p.id}/mark-shared`, "POST", {
                            sha: c.sha,
                          })
                            .then(() => {
                              refresh();
                              toast.success("Marked as shared");
                            })
                            .catch(message)
                        }
                      />
                    </div>
                    {expanded.has(c.sha) && (
                      <div className="commit-detail">
                        {c.body && <pre>{c.body}</pre>}
                        <ul>
                          {c.files.map((f) => (
                            <li className="mono" key={f.path}>
                              {f.path}{" "}
                              <span className="muted">
                                +{f.insertions} −{f.deletions}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                </Fragment>
              );
            })}
            {commits.length >= limit && (
              <Button className="older" onClick={() => setLimit((l) => l + 50)}>
                Show older
              </Button>
            )}
          </div>
        )}
        {selected.size > 0 && (
          <div className="selection-bar">
            <span>{selected.size} selected</span>
            <Button onClick={() => setSelected(new Set())}>Clear</Button>
            <Button
              variant="default"
              disabled={p.readOnly}
              onClick={() => setAngleOpen(true)}
            >
              Create story from {selected.size}{" "}
              {selected.size === 1 ? "commit" : "commits"}
            </Button>
          </div>
        )}
      </section>
      {angleOpen && (
        <AnglesSheet
          p={p}
          commits={(commits || [])
            .filter((c) => selected.has(c.sha))
            .map((c) => c.sha)}
          open
          onClose={() => setAngleOpen(false)}
        />
      )}
      <aside className="project-sidebar">
        <section>
          <h2>About this project</h2>
          <p>
            {context.data?.shareable
              .replace(/^#.*\n/, "")
              .trim()
              .slice(0, 240) ||
              "Add shareable notes so your stories have the right context."}
          </p>
          <Button variant="ghost" onClick={onContext}>
            Edit context
          </Button>
        </section>
        <section>
          <h2>Active stories</h2>
          {stories.data
            ?.filter(
              (v) =>
                v.story.status !== "published" && v.story.status !== "archived",
            )
            .map((v) => (
              <p key={v.story.id}>
                <Link
                  to="/projects/$projectId/stories/$storyId"
                  params={{ projectId: p.id, storyId: v.story.id }}
                >
                  {v.story.title}
                </Link>
              </p>
            ))}
          {!stories.data?.length && <p>No active stories yet.</p>}
        </section>
        <section>
          <h2>Last post</h2>
          {(() => {
            const last = stories.data
              ?.flatMap((v) => v.posts)
              .filter((v) => v.post.publishedAt)
              .sort((a, b) =>
                b.post.publishedAt!.localeCompare(a.post.publishedAt!),
              )[0];
            return last ? (
              <p>
                <a
                  href={last.post.publishedUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {last.revisions.at(-1)?.parts[0].slice(0, 160)}
                </a>
              </p>
            ) : (
              <p>Nothing published yet.</p>
            );
          })()}
        </section>
      </aside>
    </div>
  );
}
