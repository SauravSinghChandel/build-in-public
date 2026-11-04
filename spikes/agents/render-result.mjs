import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateDraft } from './validate.mjs';
const root = new URL('./', import.meta.url);
export async function renderResult(report) {
  const pending = report.checks.some(c => c.status === 'PENDING');
  const failures = report.checks.some(c => c.status === 'FAIL');
  const verdict = failures ? 'NO-GO — a live acceptance check failed; inspect out/report.json.' : pending
    ? 'GO-with-caveats — harness ready; the two-provider/security/draft-quality decision needs a host run.'
    : 'GO-with-caveats — automated checks passed; human draft-quality review still required.';
  let tap = '';
  try { tap = await readFile(new URL('./out/unit-tests.tap', root), 'utf8'); } catch {}
  const tests = tap.match(/^# pass (\d+)/m)?.[1] ?? 'not recorded';
  const lines = [verdict, '', '| Acceptance check | Status | Evidence |', '|---|---|---|',
    `| Local parser/process/length tests | ${/^# fail 0$/m.test(tap) ? 'PASS' : 'PENDING'} | ${tests} tests; out/unit-tests.tap; fixture streams, malformed JSON, missing binary, SIGTERM escalation |`,
    `| Context bundle, bundle-only draft inputs | ${report.context ? 'PASS' : 'PENDING'} | ${report.context?.commitCount ?? '?'} commits; ${report.context?.bytes ?? '?'} bytes; out/context-bundle.txt; no portfolio --add-dir |`];
  for (const c of report.checks) {
    const r = report.runs[c.id];
    let evidence;
    if (r) {
      evidence = `exit=${r.exitCode}, signal=${r.exitSignal ?? 'none'}, startup=${r.startupMs == null ? 'unavailable' : Math.round(r.startupMs) + 'ms'}, total=${Math.round(r.totalMs)}ms; canaries=${JSON.stringify(r.canaries ?? [])}; out/${c.id}.events.json`;
      if (c.status === 'PENDING') evidence += '; sandbox EROFS, host rerun required';
      if (r.costUsd != null) evidence += `; $${r.costUsd.toFixed(6)}`;
      if (report.drafts[c.id]) evidence += `; lengths ${JSON.stringify(validateDraft(report.drafts[c.id], c.id.endsWith('rewrite')))}`;
    } else evidence = 'PENDING — run `node spikes/agents/run-all.mjs` outside the sandbox';
    lines.push(`| ${c.id} | ${c.status} | ${evidence.replaceAll('|', '\\|')} |`);
  }
  lines.push('', '**Gotchas and exact versions/flags**',
    `- ${Object.entries(report.versions).map(([k,v]) => `${k}: ${v}`).join('; ')}. Startup means first stdout bytes, not first model token.`,
    '- Claude: `-p --output-format stream-json --verbose --json-schema <schema> --permission-mode dontAsk --allowedTools Read,Grep,Glob --add-dir <repo> --strict-mcp-config --setting-sources user --max-budget-usd 1 [--resume <id>] -- <prompt>`; fresh cwd, never --bare.',
    '- Codex: `exec --json --output-schema <file> -s read-only -C <workspace> --add-dir <repo> --skip-git-repo-check [resume <id>] -- <prompt>`; parent options precede resume. stdin is ignored by spawn (equivalent to `< /dev/null`).',
    '- Codex help calls --add-dir writable; read-only sandbox stays explicit. Absence of canaries alone cannot prove instructions were not loaded. Positive control remains essential.',
    `- This suite used ${report.claudeCalls} Claude call(s), each capped at $1; a full suite uses at most 6. The earlier saved probe used 1 additional call (out/probe-report.json). No credentials read/copied or auth/home workaround attempted.`,
    '- SIGINT escalates after 2s to SIGTERM, then after 2s to SIGKILL for bounded cleanup. Live checks time out after 180s. Raw logs are capped at 1 MB per stream.',
    '- Gitignore cannot filter by size: runner adds exact entries for artifacts >20 MiB; node_modules/ is always ignored. npm cache uses /tmp/bip-spike-agents/npm-cache. twitter-text brings deprecated core-js/punycode warnings.',
    '- Plan section L says PoC-1 is verified; this run does not establish that: control, Codex isolation, live resume/cancel and draft quality are pending.',
    '', '**Recommendation**',
    'Use fixed argv, fresh task workspaces, read-only tools/sandbox, bundle-first prompts, persisted session IDs, and process-group cancellation. Keep the isolation/security decision provisional until the host suite and positive control pass; manually review factual claims and voice.',
    '', '**Drafts for review**');
  for (const id of ['claude-draft', 'codex-draft', 'claude-rewrite']) {
    const d = report.drafts[id];
    lines.push(`**${id}**${d ? ` (${Math.round(report.runs[id].totalMs)} ms)` : ': PENDING — no live draft generated.'}`);
    if (!d) continue;
    for (const [i, part] of d.x.parts.entries()) lines.push(`X ${i + 1}: ${part}`);
    if (d.linkedin) lines.push(`LinkedIn:\n${d.linkedin.text}`);
    if (d.highlights) lines.push(`Highlights: ${JSON.stringify(d.highlights)}; claims_to_verify: ${JSON.stringify(d.claims_to_verify)}`);
  }
  lines.push('', '**How to re-run (from repo root, outside sandbox)**', '```bash',
    'npm ci --prefix spikes/agents --cache /tmp/bip-spike-agents/npm-cache --no-audit --no-fund',
    'node --test spikes/agents/test.mjs > spikes/agents/out/unit-tests.tap 2>&1',
    'node spikes/agents/run-all.mjs', '```',
    'Runner sets up/cleans canaries, runs all live checks, and refreshes RESULT.md, out/report.json, and out/drafts.md. Source event shapes: [Claude](https://code.claude.com/docs/en/agent-sdk/streaming-output), [structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs), [Codex](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts).');
  await writeFile(new URL('./RESULT.md', root), lines.join('\n') + '\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await renderResult(JSON.parse(await readFile(new URL('./out/report.json', root), 'utf8')));
