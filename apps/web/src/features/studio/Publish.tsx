import { intentUrl, publishUrl, type PostView } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message, useRefresh } from "../../components/workspace";
import { PublishImages } from "../image/Attachments";
export function PublishSheet({
  pId,
  view,
  onClose,
}: {
  pId: string;
  view: PostView;
  onClose: () => void;
}) {
  const { post, revisions } = view,
    revision = revisions.find((r) => r.id === post.currentRevisionId)!;
  const base = `/projects/${pId}/stories/${post.storyId}/posts/${post.id}`;
  const check = useQuery({
    queryKey: ["checklist", post.id, revision.id],
    queryFn: () =>
      api<{
        revisionId: string;
        secrets: string[];
        privateMatches: string[];
        claims: string[];
        warnings: string[];
        intentUrl: string;
      }>(base + "/checklist"),
  });
  const [checked, setChecked] = useState<number[]>([]),
    [ack, setAck] = useState(false),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  const approved = post.approvedRevisionId === revision.id;
  const approve = async () => {
    setBusy(true);
    try {
      await api(base + "/approve", "POST", {
        revisionId: revision.id,
        checked,
        acknowledgePrivate: ack,
      });
      refresh();
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const mark = async () => {
    setBusy(true);
    try {
      await api(base + "/publish", "POST", { url });
      refresh();
      onClose();
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const openLinkedIn = async () => {
    try {
      await navigator.clipboard.writeText(revision.parts[0]);
      window.open(
        intentUrl(revision.parts, "linkedin"),
        "_blank",
        "noopener,noreferrer",
      );
    } catch (e) {
      message(e);
    }
  };
  return (
    <Dialog
      sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Publish ${post.platform === "x" ? "X" : "LinkedIn"} post`}
    >
      <div className="publish-sheet">
        {revision.parts.map((part, i) => (
          <div className="post-preview" key={i}>
            <p>{part}</p>
            {approved && (
              <Button
                onClick={() =>
                  void navigator.clipboard.writeText(part).catch(message)
                }
              >
                Copy text{revision.parts.length > 1 ? ` · part ${i + 1}` : ""}
              </Button>
            )}
          </div>
        ))}
        {url && !publishUrl(url, post.platform) && (
          <p role="alert" className="error">
            Paste a link from {post.platform === "x" ? "x.com" : "linkedin.com"}
          </p>
        )}
        <PublishImages project={pId} post={post} />
        <h3>Review before approving</h3>
        {check.isPending ? (
          <p>Scanning final text…</p>
        ) : check.error ? (
          <p className="error">{String(check.error)}</p>
        ) : (
          <>
            <p>
              {check.data?.secrets.length
                ? "Possible secrets found"
                : "Secret scan: no matches"}
            </p>
            {check.data?.secrets.map((w) => (
              <p className="error" key={w}>
                {w}
              </p>
            ))}
            {!!check.data?.privateMatches.length && (
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                I reviewed Never mention warnings:{" "}
                {check.data.privateMatches.join(", ")}
              </label>
            )}
            {check.data?.claims.map((claim, i) => (
              <label className="check-row" key={i}>
                <input
                  type="checkbox"
                  checked={checked.includes(i)}
                  onChange={(e) =>
                    setChecked((v) =>
                      e.target.checked ? [...v, i] : v.filter((n) => n !== i),
                    )
                  }
                />
                {claim}
              </label>
            ))}
            {check.data?.warnings.map((w) => (
              <p className="muted" key={w}>
                {w}
              </p>
            ))}
          </>
        )}
        {!approved ? (
          <Button
            variant="default"
            disabled={
              busy ||
              !check.data ||
              !!check.data.secrets.length ||
              check.data.claims.some((_, i) => !checked.includes(i)) ||
              (!!check.data.privateMatches.length && !ack)
            }
            onClick={() => void approve()}
          >
            Approve
          </Button>
        ) : (
          <>
            <p className="chip">Approved revision</p>
            {post.platform === "x" ? (
              <a
                className="button secondary"
                target="_blank"
                rel="noreferrer"
                href={intentUrl(revision.parts, "x")}
              >
                Open X
              </a>
            ) : (
              <Button onClick={() => void openLinkedIn()}>Open LinkedIn</Button>
            )}
            {revision.parts.length > 1 && (
              <p className="muted">
                Open X starts part 1. Copy the remaining parts into replies to
                build your thread.
              </p>
            )}
            <p className="muted small">
              You publish in the platform. Build in Public never posts for you.
            </p>
            <label className="field">
              Paste the published link
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  post.platform === "x"
                    ? "https://x.com/you/status/…"
                    : "https://www.linkedin.com/posts/…"
                }
              />
            </label>
            <Button
              variant="default"
              disabled={busy || !publishUrl(url, post.platform)}
              onClick={() => void mark()}
            >
              Mark as published
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
