import type { AccountsView, PlatformAccountsView } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import {
  ErrorBox,
  Loading,
  message,
  useRefresh,
} from "../../components/workspace";

/** Settings view: includes the secret store (may probe the keychain). */
export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<AccountsView>("/accounts"),
  });
}
/** Connected-account metadata only; never touches the keychain. */
export function useAccountMetadata() {
  return useQuery({
    queryKey: ["accounts", "metadata"],
    queryFn: () => api<AccountsView>("/accounts?metadata=1"),
  });
}
export const platformName = (p: string) => (p === "x" ? "X" : "LinkedIn");
export const accountLabel = (a: { platform: string; handle: string }) =>
  a.platform === "x" ? `@${a.handle}` : a.handle;
const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function AccountsSettings() {
  const accounts = useAccounts();
  const params = new URLSearchParams(location.search);
  const oauthError = params.get("oauthError");
  return (
    <>
      <p className="muted">
        Optional. Connect your own developer apps to post and schedule directly.
        Without accounts, Build in Public keeps the assisted flow: copy the
        text, open the platform and paste the published link.
      </p>
      {oauthError && (
        <p role="alert" className="error">
          Couldn't connect: {oauthError}
        </p>
      )}
      {accounts.isPending && <Loading />}
      {accounts.error && <ErrorBox error={accounts.error} />}
      {accounts.data?.secretStore?.warning && (
        <p role="note" className="notice">
          {accounts.data.secretStore?.warning}
        </p>
      )}
      {accounts.data?.platforms.map((p) => (
        <PlatformAccount key={p.platform} view={p} />
      ))}
    </>
  );
}

function PlatformAccount({ view }: { view: PlatformAccountsView }) {
  const name = platformName(view.platform);
  const [clientId, setClientId] = useState(view.app?.clientId || ""),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  const needsSecret = view.platform === "linkedin" && !view.app?.hasSecret;
  const connect = async () => {
    setBusy(true);
    try {
      await api(`/accounts/${view.platform}/app`, "PUT", {
        clientId,
        ...(secret ? { clientSecret: secret } : {}),
      });
      const { url } = await api<{ url: string }>(
        `/accounts/${view.platform}/connect`,
        "POST",
      );
      location.assign(url);
    } catch (e) {
      message(e);
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm(`Disconnect ${name}? Build in Public deletes its saved sign-in.`))
      return;
    setBusy(true);
    try {
      const r = await api<{ revoked: boolean }>(
        `/accounts/${view.platform}`,
        "DELETE",
      );
      toast.success(
        r.revoked
          ? `${name} disconnected`
          : `${name} disconnected locally. Revoke the app in ${name}'s settings too.`,
      );
      refresh();
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const account = view.account;
  return (
    <section
      className="agent-row account-row"
      aria-label={`${name} account`}
    >
      <h3>{name}</h3>
      {account ? (
        <>
          <p>
            Connected as <strong>{accountLabel(account)}</strong>
          </p>
          <p className="muted small">Scopes: {account.scopes.join(" ")}</p>
          {account.reconnectBy && (
            <p className={account.expiry === "ok" ? "muted" : "error"}>
              {account.expiry === "expired"
                ? `Sign-in expired on ${date(account.reconnectBy)}. Reconnect to keep posting.`
                : `Reconnect by ${date(account.reconnectBy)}`}
            </p>
          )}
          <div className="actions">
            {account.expiry !== "ok" && (
              <Button
                variant="default"
                disabled={busy}
                onClick={() => void connect()}
              >
                Reconnect
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <Guide view={view} />
          <label className="field">
            Client ID
            <input
              value={clientId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <label className="field">
            Client Secret
            {view.platform === "x" ? " (only for confidential clients)" : ""}
            <input
              type="password"
              value={secret}
              autoComplete="off"
              placeholder={view.app?.hasSecret ? "Saved" : ""}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <Button
            variant="default"
            disabled={
              busy || !clientId.trim() || (needsSecret && !secret.trim())
            }
            onClick={() => void connect()}
          >
            Connect {name}
          </Button>
        </>
      )}
    </section>
  );
}

function Guide({ view }: { view: PlatformAccountsView }) {
  const copy = () =>
    void navigator.clipboard
      .writeText(view.redirectUri)
      .then(() => toast.success("Redirect URI copied"))
      .catch(message);
  return (
    <div className="account-guide">
      <ol>
        {view.platform === "x" ? (
          <>
            <li>
              Create a project and app in the{" "}
              <a
                href="https://developer.x.com/en/portal/dashboard"
                target="_blank"
                rel="noreferrer"
              >
                X developer portal
              </a>
              .
            </li>
            <li>
              Under User authentication settings, enable OAuth 2.0 (type: Web
              App or Native App) with Read and write permissions.
            </li>
          </>
        ) : (
          <>
            <li>
              Create an app in the{" "}
              <a
                href="https://www.linkedin.com/developers/apps"
                target="_blank"
                rel="noreferrer"
              >
                LinkedIn developer portal
              </a>
              .
            </li>
            <li>
              Add the products "Sign In with LinkedIn using OpenID Connect" and
              "Share on LinkedIn".
            </li>
          </>
        )}
        <li>
          Register this exact redirect URI:{" "}
          <code className="mono">{view.redirectUri}</code>{" "}
          <Button size="icon" aria-label="Copy redirect URI" onClick={copy}>
            <Copy />
          </Button>
        </li>
        <li>
          Scopes: <code className="mono">{view.scopes.join(" ")}</code>
        </li>
        <li>
          Paste the Client ID
          {view.platform === "linkedin" ? " and Client Secret" : ""} from the
          app's {view.platform === "x" ? "Keys and tokens" : "Auth"} tab.
        </li>
      </ol>
      {view.platform === "x" ? (
        <p className="muted small">
          X bills API use per request: about $0.015 per post, and posts that
          contain a link reportedly cost far more (about $0.20). Check{" "}
          <a
            href="https://docs.x.com/x-api/getting-started/pricing"
            target="_blank"
            rel="noreferrer"
          >
            X's pricing page
          </a>{" "}
          for current prices.
        </p>
      ) : (
        <p className="muted small">
          LinkedIn sign-ins last about 60 days. Build in Public shows when to
          reconnect.
        </p>
      )}
    </div>
  );
}
