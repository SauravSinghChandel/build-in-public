import { ERROR_DETAILS, stripAnsi } from "@bip/shared";

type StepLike = { action: string; selector?: string };
const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || "Unknown error";

/** Builds an Error whose message is `friendly`, with the raw (ANSI-free) log kept as details. */
export function withDetails(friendly: string, raw: string) {
  const clean = stripAnsi(raw).trim();
  return Error(
    clean && clean !== friendly ? friendly + ERROR_DETAILS + clean : friendly,
  );
}

/** Maps Playwright step failures to messages a person can act on. */
export function friendlyStepError(
  index: number,
  step: StepLike,
  error: unknown,
) {
  const raw = stripAnsi(error instanceof Error ? error.message : String(error));
  const label = `Step ${index + 1}`;
  const sel = step.selector ? `\`${step.selector}\`` : "";
  let message: string;
  const strict = /strict mode violation: .*? resolved to (\d+) elements/i.exec(
    raw,
  );
  if (strict && sel)
    message = `${label}: ${sel} matches ${strict[1]} elements. Make it more specific.`;
  else if (
    /while parsing (?:css )?selector|Unexpected token|is not a valid selector|Unknown engine/i.test(
      raw,
    ) &&
    sel
  )
    message = `${label}: ${sel} isn't a valid selector.`;
  else if (
    (/Timeout \d+ms exceeded|TimeoutError|selector not found|not found/i.test(
      raw,
    ) ||
      (error as Error)?.name === "TimeoutError") &&
    sel
  )
    message = `${label}: couldn't find ${sel}.`;
  else if (/Timeout \d+ms exceeded/i.test(raw))
    message = `${label} (${step.action}) timed out.`;
  else message = `${label} (${step.action}) failed: ${firstLine(raw)}`;
  return withDetails(message, raw);
}

/** Maps navigation failures (page.goto) to a friendly message. */
export function friendlyNavigationError(url: string, error: unknown) {
  const raw = stripAnsi(error instanceof Error ? error.message : String(error));
  const net = /net::(ERR_[A-Z_]+)/.exec(raw)?.[1];
  const reasons: Record<string, string> = {
    ERR_CONNECTION_REFUSED:
      "connection refused. Check that the site is running",
    ERR_NAME_NOT_RESOLVED: "the host name couldn't be resolved. Check the URL",
    ERR_UNSAFE_PORT: "Chromium blocks this port. Use a different port",
    ERR_CONNECTION_RESET: "the connection was reset. Try again",
    ERR_CERT_AUTHORITY_INVALID: "its certificate isn't trusted",
  };
  const message = net
    ? `Couldn't open ${url}: ${reasons[net] || net}.`
    : /Timeout \d+ms exceeded/i.test(raw)
      ? `Couldn't open ${url}: the page took longer than 30 seconds to load.`
      : `Couldn't open ${url}: ${firstLine(raw)}`;
  return withDetails(message, raw);
}

/** Runs one step and rethrows failures as friendly errors (aborts pass through untouched). */
export async function runStep<T extends StepLike>(
  index: number,
  step: T,
  fn: () => Promise<void>,
  signal?: AbortSignal,
) {
  try {
    await fn();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw friendlyStepError(index, step, e);
  }
}
