import {
  textLength,
  type PostView,
  type ProjectRow,
  type StoryView,
} from "@bip/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import {
  ErrorBox,
  Loading,
  message,
  useRefresh,
} from "../../components/workspace";
import { AnglesSheet } from "./Angles";
import { AgentPicker, JobFeedback, useJobs } from "./jobs";
import { PublishSheet } from "./Publish";
export function Stories({ p, storyId }: { p: ProjectRow; storyId?: string }) {
  const [create, setCreate] = useState(false);
  const query = useQuery<StoryView | StoryView[]>({
    queryKey: ["stories", p.id, storyId],
    queryFn: () =>
      storyId
        ? api<StoryView>(`/projects/${p.id}/stories/${storyId}`)
        : api<StoryView[]>(`/projects/${p.id}/stories`),
  });
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  if (storyId)
    return <StoryEditor key={storyId} p={p} view={query.data as StoryView} />;
  return (
    <>
      <div className="section-heading">
        <h2>Stories</h2>
        <Button onClick={() => setCreate(true)}>New story</Button>
      </div>
      {(query.data as StoryView[]).length ? (
        (query.data as StoryView[]).map((v) => (
          <Link
            className="story-row"
            to="/projects/$projectId/stories/$storyId"
            params={{ projectId: p.id, storyId: v.story.id }}
            key={v.story.id}
          >
            <strong>{v.story.title}</strong>
            <span className="chip">{v.story.status}</span>
            <span>
              {v.posts
                .map((p) => (p.post.platform === "x" ? "X" : "LinkedIn"))
                .join(" · ")}
            </span>
            <time>{new Date(v.story.updatedAt).toLocaleDateString()}</time>
          </Link>
        ))
      ) : (
        <p className="muted">
          Select commits in Overview, or start with a note.
        </p>
      )}
      {create && (
        <AnglesSheet p={p} commits={[]} open onClose={() => setCreate(false)} />
      )}
    </>
  );
}
function StoryEditor({ p, view }: { p: ProjectRow; view: StoryView }) {
  const { story } = view;
  const [title, setTitle] = useState(story.title),
    [brief, setBrief] = useState(story.brief),
    [agent, setAgent] = useState(
      p.settings.lastAgent?.["post.draft"] || "claude",
    );
  const refresh = useRefresh(),
    jobs = useJobs();
  const storyJobs =
    jobs.data?.filter(
      (j) => j.payload.storyId === story.id && !j.payload.postId,
    ) || [];
  const save = () =>
    void api(`/projects/${p.id}/stories/${story.id}`, "PATCH", { title, brief })
      .then(refresh)
      .catch(message);
  return (
    <div className="story-editor">
      <Link to="/projects/$projectId/stories" params={{ projectId: p.id }}>
        All stories
      </Link>
      <label className="field">
        Story title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
        />
      </label>
      <label className="field">
        Brief
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={save}
        />
      </label>
      <span className="chip">{story.status}</span>

      {!view.posts.length && (
        <div className="actions">
          <Button
            disabled={storyJobs.some((j) =>
              ["running", "queued"].includes(j.status),
            )}
            onClick={() =>
              void api(`/projects/${p.id}/stories/${story.id}/draft`, "POST", {
                provider: agent,
              })
                .then(refresh)
                .catch(message)
            }
          >
            Draft X and LinkedIn
          </Button>
          <AgentPicker
            p={p}
            task="post.draft"
            value={agent}
            onChange={setAgent}
          />
        </div>
      )}
      <div className="draft-panels">
        {!view.posts.length && storyJobs.length > 0 && (
          <>
            <section className="draft-panel" aria-label="X draft">
              <h2>X</h2>
              <JobFeedback job={storyJobs.at(-1)} />
            </section>
            <section className="draft-panel" aria-label="LinkedIn draft">
              <h2>LinkedIn</h2>
              <p className="muted">Both platforms are generated together.</p>
            </section>
          </>
        )}
        {view.posts.map((post) => (
          <PostPanel
            key={post.post.id}
            p={p}
            view={post}
            allPosts={view.posts}
          />
        ))}
      </div>
    </div>
  );
}
function PostPanel({
  p,
  view,
  allPosts,
}: {
  p: ProjectRow;
  view: PostView;
  allPosts: PostView[];
}) {
  const { post, revisions } = view;
  const current = revisions.find((r) => r.id === post.currentRevisionId);
  const [parts, setParts] = useState(current?.parts || [""]),
    [status, setStatus] = useState("Saved"),
    [instruction, setInstruction] = useState(""),
    [tone, setTone] = useState("Casual"),
    [agent, setAgent] = useState(
      p.settings.lastAgent?.["post.edit"] || "claude",
    ),
    [publish, setPublish] = useState(false);
  const refresh = useRefresh(),
    q = useQueryClient(),
    jobs = useJobs(),
    base = `/projects/${p.id}/stories/${post.storyId}/posts/${post.id}`;
  const job = jobs.data?.filter((j) => j.payload.postId === post.id).at(-1);
  const active = !!job && ["running", "queued"].includes(job.status);
  const serverText = useRef(JSON.stringify(current?.parts || [""])),
    latest = useRef(parts),
    chain = useRef(Promise.resolve()),
    pending = useRef(false);
  latest.current = parts;
  const save = (value: string[]) => {
    const text = JSON.stringify(value);
    if (text === serverText.current) return chain.current;
    pending.current = true;
    setStatus("Saving…");
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        await api(base + "/revisions", "POST", {
          parts: value,
          coalesce: true,
        });
        serverText.current = text;
        pending.current = false;
        setStatus("Saved");
        await q.invalidateQueries({ queryKey: ["stories", p.id] });
      });
    return chain.current.catch((e) => {
      pending.current = false;
      setStatus("Could not save");
      message(e);
      throw e;
    });
  };
  useEffect(() => {
    const next = JSON.stringify(current?.parts || [""]);
    if (
      !pending.current &&
      JSON.stringify(latest.current) === serverText.current
    ) {
      serverText.current = next;
      setParts(current?.parts || [""]);
    }
  }, [current?.id, current?.editedAt]);
  useEffect(() => {
    if (JSON.stringify(parts) === serverText.current) return;
    setStatus("Unsaved");
    const timer = setTimeout(() => {
      void save(parts).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [parts]);
  useEffect(
    () => () => {
      void save(latest.current).catch(() => {});
    },
    [],
  );
  const edit = async (text: string, extra: Record<string, unknown> = {}) => {
    try {
      await save(latest.current);
      await api(base + "/edit", "POST", {
        provider: agent,
        instruction: text,
        ...extra,
      });
      refresh();
    } catch (e) {
      message(e);
    }
  };
  const restore = async (id: string) => {
    try {
      await save(latest.current);
      await api(base + "/restore", "POST", { revisionId: id });
      refresh();
    } catch (e) {
      message(e);
    }
  };
  const other = allPosts.find((v) => v.post.platform !== post.platform);
  return (
    <section
      className="draft-panel"
      aria-label={`${post.platform === "x" ? "X" : "LinkedIn"} draft`}
    >
      <div className="section-heading">
        <h2>
          {post.platform === "x" ? "X" : "LinkedIn"}
          {post.replyToPostId ? " follow-up" : ""}
        </h2>
        <span className="chip">{post.status}</span>
        <small>{status}</small>
      </div>
      {parts.map((part, i) => (
        <div className="thread-part" key={i}>
          <label className="field">
            {post.platform === "x" ? `X part ${i + 1}` : "LinkedIn text"}
            <textarea
              disabled={active || p.readOnly}
              value={part}
              onChange={(e) =>
                setParts((v) => v.map((s, n) => (n === i ? e.target.value : s)))
              }
            />
          </label>
          <div className="actions">
            <span
              className={
                textLength(part, post.platform) >
                (post.platform === "x" ? 280 : 1200)
                  ? "error"
                  : "muted"
              }
            >
              {textLength(part, post.platform)} /{" "}
              {post.platform === "x" ? "280" : "1,200"}
            </span>
            {post.platform === "x" && parts.length > 1 && (
              <>
                <Button
                  aria-label={`Move part ${i + 1} up`}
                  disabled={i === 0 || active}
                  onClick={() =>
                    setParts((v) => {
                      const n = [...v];
                      [n[i - 1], n[i]] = [n[i], n[i - 1]];
                      return n;
                    })
                  }
                >
                  Up
                </Button>
                <Button
                  aria-label={`Move part ${i + 1} down`}
                  disabled={i === parts.length - 1 || active}
                  onClick={() =>
                    setParts((v) => {
                      const n = [...v];
                      [n[i + 1], n[i]] = [n[i], n[i + 1]];
                      return n;
                    })
                  }
                >
                  Down
                </Button>
                <Button
                  disabled={active}
                  onClick={() => setParts((v) => v.filter((_, n) => n !== i))}
                >
                  Remove part {i + 1}
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
      {post.platform === "x" && parts.length < 4 && (
        <Button disabled={active} onClick={() => setParts((v) => [...v, ""])}>
          Add part
        </Button>
      )}
      {view.warnings.map((w) => (
        <p className="error" key={w}>
          {w}
        </p>
      ))}
      <JobFeedback job={job} />
      <div className="edit-actions">
        <AgentPicker p={p} task="post.edit" value={agent} onChange={setAgent} />
        {["Regenerate", "Shorten", "Expand"].map((action) => (
          <Button
            key={action}
            disabled={active || p.readOnly}
            onClick={() => void edit(action)}
          >
            {action}
          </Button>
        ))}
        <select
          aria-label={`${post.platform} tone`}
          value={tone}
          onChange={(e) => setTone(e.target.value)}
        >
          {["Casual", "Technical", "Professional", "Playful"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <Button disabled={active} onClick={() => void edit(`Tone: ${tone}`)}>
          Apply tone
        </Button>
        {other && (
          <Button
            disabled={active}
            onClick={() =>
              void edit(`Adapt from ${other.post.platform}`, {
                sourcePostId: other.post.id,
              })
            }
          >
            Adapt from {other.post.platform === "x" ? "X" : "LinkedIn"}
          </Button>
        )}
        <Button
          disabled={active}
          onClick={() =>
            void edit("Write a follow-up replying to this post", {
              followUp: true,
            })
          }
        >
          Follow-up
        </Button>
      </div>
      <label className="field">
        Instruction
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="What would you change?"
        />
      </label>
      <Button
        disabled={active || !instruction.trim()}
        onClick={() => void edit(instruction)}
      >
        Apply instruction
      </Button>
      <h3>Claims to verify</h3>
      {view.claims.length ? (
        <ul>
          {view.claims.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No unresolved claims.</p>
      )}
      <h3>Revisions</h3>
      <div className="revision-timeline">
        {revisions.map((r, i) => (
          <div className="revision-row" key={r.id}>
            <span className="revision-label" tabIndex={0}>
              <span>
                Revision {i + 1} · {r.author}
                {r.instruction ? ` · ${r.instruction}` : ""}
              </span>
              <pre className="revision-diff" role="tooltip">
                {r.parts
                  .map((part, n) => {
                    const before = revisions[i - 1]?.parts[n] || "";
                    if (before === part) return "  " + part;
                    return (
                      (before
                        ? "- " + before.split("\n").join("\n- ") + "\n"
                        : "") +
                      "+ " +
                      part.split("\n").join("\n+ ")
                    );
                  })
                  .join("\n\n")}
              </pre>
            </span>
            <Button disabled={active} onClick={() => void restore(r.id)}>
              Restore revision {i + 1}
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="default"
        disabled={active || !current}
        onClick={() =>
          void save(latest.current)
            .then(() => setPublish(true))
            .catch(() => {})
        }
      >
        Review and publish
      </Button>
      {post.publishedUrl && (
        <a target="_blank" rel="noreferrer" href={post.publishedUrl}>
          Published post
        </a>
      )}
      {publish && (
        <PublishSheet
          pId={p.id}
          view={view}
          onClose={() => setPublish(false)}
        />
      )}
    </section>
  );
}
