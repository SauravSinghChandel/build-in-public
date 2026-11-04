import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { JsonlParser, buildArgs, createHarness } from './harness.mjs';
import { summarySchema } from './schemas.mjs';
import { validateSchema, validateDraft } from './validate.mjs';

for (const provider of ['claude', 'codex']) test(`${provider}: chunked fixture, result/session/tool/text`, async () => {
  const fixture = await readFile(new URL(`./fixtures/${provider}.jsonl`, import.meta.url), 'utf8');
  const state = {}; const parser = new JsonlParser(provider, state); const events = [];
  for (let i = 0; i < fixture.length; i += 7) events.push(...parser.push(fixture.slice(i, i + 7)));
  events.push(...parser.push('', true));
  assert.equal(state.sessionId, `${provider}-fixture`);
  assert.deepEqual(state.structuredOutput, { summary: 'paper boats' });
  assert.equal(state.completed, true);
  assert.ok(events.some(e => e.type === 'text'));
  assert.ok(events.some(e => e.type === 'tool'));
  assert.equal(events.filter(e => e.type === 'error').length, 0);
});
test('malformed JSON and unterminated final line are handled', () => {
  const parser = new JsonlParser('codex', {});
  const events = parser.push('broken\n{"type":"error","message":"failed"}', true);
  assert.equal(events.length, 2);
  assert.match(events[0].message, /Invalid JSONL/);
  assert.equal(events[1].message, 'failed');
});
test('provider failure events cannot be mistaken for success', () => {
  for (const [p, line] of [['claude', { type: 'result', subtype: 'error_max_budget_usd', is_error: true }],
    ['codex', { type: 'turn.failed', error: { message: 'no access' } }]]) {
    const state = {}; const e = new JsonlParser(p, state).push(JSON.stringify(line), true);
    assert.equal(state.completed, false); assert.equal(e[0].type, 'error');
  }
});
test('schema validates actual shape, rejects extra fields and missing properties', () => {
  assert.equal(validateSchema(summarySchema, { summary: 'ok' }).valid, true);
  assert.equal(validateSchema(summarySchema, { summary: 1 }).valid, false);
  assert.equal(validateSchema(summarySchema, { summary: 'ok', extra: true }).valid, false);
});
test('X weighted length, thread count, LinkedIn limits and hashtag checks', () => {
  const draft = { x: { parts: ['a'.repeat(280)] }, linkedin: { text: 'Hook\n' + 'a'.repeat(595) }, highlights: [], claims_to_verify: [] };
  assert.equal(validateDraft(draft).valid, true);
  draft.x.parts = ['a'.repeat(281)]; assert.equal(validateDraft(draft).valid, false);
  draft.x.parts = ['界'.repeat(141)]; assert.equal(validateDraft(draft).valid, false);
  draft.x.parts = ['https://example.com/' + 'a'.repeat(300)]; assert.equal(validateDraft(draft).valid, true);
  draft.x.parts = ['#one #two #three']; assert.equal(validateDraft(draft).valid, false);
  draft.x.parts = Array(5).fill('ok'); assert.equal(validateDraft(draft).valid, false);
  draft.x.parts = ['ok']; draft.linkedin.text = 'Hook\nshort'; assert.equal(validateDraft(draft).valid, false);
  draft.linkedin.text = 'Hook\n' + 'a'.repeat(1196); assert.equal(validateDraft(draft).valid, false);
});
test('args keep prompt atomic, budget every Claude call, exec options before resume', () => {
  const opts = { prompt: 'literal $(touch X) `hi`', workspace: '/tmp/work', readDirs: ['/tmp/read'], outputSchema: summarySchema, schemaFile: '/tmp/schema', resumeSessionId: 'session' };
  const c = buildArgs({ ...opts, provider: 'claude' });
  assert.equal(c[c.indexOf('--max-budget-usd') + 1], '1'); assert.ok(c.includes('-p'));
  assert.equal(c.at(-1), opts.prompt); assert.ok(!c.includes('--bare'));
  const x = buildArgs({ ...opts, provider: 'codex' });
  assert.ok(x.indexOf('-s') < x.indexOf('resume')); assert.equal(x[x.indexOf('-s') + 1], 'read-only');
  assert.deepEqual(x.slice(-4), ['resume', 'session', '--', opts.prompt]);
});
async function fakeRun(script, cancelMs) {
  const workspace = await mkdtemp('/tmp/bip-spike-agents/test-');
  const controller = new AbortController(); let timer;
  const fakeSpawn = (_binary, _args, options) => spawn(process.execPath, ['-e', script], options);
  const events = [];
  try {
    if (cancelMs) timer = setTimeout(() => controller.abort(), cancelMs);
    for await (const e of createHarness(fakeSpawn)({ provider: 'codex', workspace, prompt: 'test', signal: controller.signal })) events.push(e);
    return events;
  } finally { clearTimeout(timer); await rm(workspace, { recursive: true, force: true }); }
}
test('harness streams events and final exit, not just parser output', async () => {
  const events = await fakeRun(`console.log(JSON.stringify({type:'thread.started',thread_id:'test'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"summary":"ok"}'}}));console.log(JSON.stringify({type:'turn.completed'}));`);
  assert.equal(events.at(-1).exitCode, 0); assert.equal(events.at(-1).sessionId, 'test');
  assert.equal(events.at(-1).completed, true); assert.equal(events[0].type, 'text');
});
test('AbortSignal escalates SIGINT to SIGTERM after 2s and reaps process', async () => {
  const events = await fakeRun(`process.on('SIGINT',()=>{}); console.log(JSON.stringify({type:'thread.started',thread_id:'cancel'}));setInterval(()=>{},100);`, 300);
  const final = events.at(-1);
  assert.equal(final.cancelled, true); assert.equal(final.exitSignal, 'SIGTERM');
  assert.ok(final.totalMs >= 2200 && final.totalMs < 6000);
});
test('missing executable emits error and terminal result', async () => {
  const workspace = await mkdtemp('/tmp/bip-spike-agents/test-');
  try {
    const events = [];
    const harness = createHarness((_p, _a, o) => spawn('/nonexistent/bip-spike-agents', [], o));
    for await (const e of harness({ provider: 'codex', workspace, prompt: 'test' })) events.push(e);
    assert.ok(events.some(e => e.type === 'error' && /ENOENT/.test(e.message)));
    assert.equal(events.at(-1).final, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
