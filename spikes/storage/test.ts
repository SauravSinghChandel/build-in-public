import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomUUID, randomInt } from 'node:crypto';
import { openProject, ensureExcluded, atomicJsonWrite, Post, Project } from './store.ts';
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const base = '/tmp/bip-spike-storage'; await fs.mkdir(base, { recursive: true });
const run = await fs.mkdtemp(path.join(base, 'run-'));
const evidence: Record<string, any> = { run, versions: { node: process.version, git: (await exec('git', ['--version'])).stdout.trim(), zod: JSON.parse(await fs.readFile(path.join(here, 'node_modules/zod/package.json'), 'utf8')).version }, checks: {} };
const git = async (repo: string, ...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
async function repo(name: string) {
  const dir = path.join(run, name); await fs.mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await fs.writeFile(path.join(dir, 'README.md'), '# Scratch\n'); await git(dir, 'add', 'README.md');
  await git(dir, '-c', 'user.name=Spike', '-c', 'user.email=spike@example.invalid', 'commit', '-m', 'root');
  return dir;
}
async function populated(name: string) {
  const dir = await repo(name); const store = await openProject(dir);
  const story = await store.createStory({ title: name });
  const post = await store.createPost(story.id, { platform: 'x' });
  return { dir, store, story, post, postFile: path.join(store.root, 'stories', story.id, 'posts', post.id, 'post.json') };
}
function check(name: string, fn: () => Promise<any>) {
  test(name, { timeout: 120_000 }, async () => {
    try { evidence.checks[name] = { ...(await fn()), status: 'PASS' }; }
    catch (e: any) { evidence.checks[name] = { status: 'FAIL', error: e.stack }; throw e; }
  });
}
function worker(mode: string, dir: string, ...args: string[]) {
  const child = fork(path.join(here, 'worker.ts'), [mode, dir, ...args], { execArgv: ['--experimental-strip-types'], silent: true });
  let stderr = ''; child.stderr?.on('data', bytes => { stderr += bytes; });
  child.on('error', () => {});
  return { child, stderr: () => stderr };
}
async function message(child: ReturnType<typeof fork>) {
  return Promise.race([
    once(child, 'message').then(([value]) => value),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('worker IPC timeout')), 10_000); timer.unref(); child.once('exit', () => clearTimeout(timer)); }),
  ]);
}
check('1 fresh repo stays clean', async () => {
  const { dir, store, story, post } = await populated('fresh');
  try {
    await store.addRevision(story.id, post.id, { parts: ['hello'], author: 'user' });
    assert.equal((await store.listStories()).length, 1);
    assert.equal(await git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
    return { repo: dir, gitStatus: '', schemaVersions: { project: 1, story: 1, post: 2, revision: 1 } };
  } finally { await store.close(); }
});
check('2 worktree uses common exclude once', async () => {
  const main = await repo('main'); const wt = path.join(run, 'worktree');
  await git(main, 'worktree', 'add', '-b', 'feature', wt);
  const a = await openProject(main); const b = await openProject(wt);
  try {
    await Promise.all([a.createStory({ title: 'main' }), b.createStory({ title: 'worktree' }), ...Array.from({ length: 20 }, (_, i) => ensureExcluded(i % 2 ? main : wt))]);
    const file = await ensureExcluded(wt); const text = await fs.readFile(file, 'utf8');
    assert.equal(file, path.join(main, '.git/info/exclude'));
    assert.equal(text.split('\n').filter(l => l === '.bip/').length, 1);
    assert.equal(await git(main, 'status', '--porcelain'), ''); assert.equal(await git(wt, 'status', '--porcelain'), '');
    return { main, worktree: wt, exclude: file, excludeOccurrences: 1, bothWritable: !a.readOnly && !b.readOnly, independentProjectIds: a.project.id !== b.project.id };
  } finally { await a.close(); await b.close(); }
});
check('3 opt-in exposes exactly context and ignore; opt-out hides', async () => {
  const { dir, store } = await populated('opt-in');
  try {
    await store.putAsset(path.join(dir, 'README.md'));
    await store.optInCommitContext();
    const status = await git(dir, 'status', '--porcelain', '--untracked-files=all');
    assert.deepEqual(status.split('\n').sort(), ['?? .bip/.gitignore', '?? .bip/context.md']);
    assert.equal(await fs.readFile(path.join(store.root, '.gitignore'), 'utf8'), '*\n!.gitignore\n!context.md\n');
    await store.optOut(); assert.equal(await git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
    return { repo: dir, optInStatus: status, optOutStatus: '' };
  } finally { await store.close(); }
});
check('4 concurrent revisions and separate process read-only', async () => {
  const { dir, store, story, post } = await populated('concurrency');
  try {
    const posts = [post]; for (let i = 1; i < 20; i++) posts.push(await store.createPost(story.id, { platform: 'x' }));
    const start = performance.now();
    const revisions = await Promise.all(Array.from({ length: 200 }, (_, i) => store.addRevision(story.id, posts[i % 20].id, { parts: [`revision ${i}`], author: 'agent' })));
    let count = 0;
    for (const p of posts) {
      const r = await store.readRevisions(story.id, p.id); assert.equal(r.revisions.length, 10); assert.equal(r.tornTail, false); count += r.revisions.length;
      assert.equal((await store.readPost(story.id, p.id)).currentRevisionId, r.revisions.at(-1)!.id);
    }
    assert.equal(new Set(revisions.map(r => r.id)).size, 200);
    const batchMs = performance.now() - start;
    // The owning writer is a separate process, too (not just the test process).
    await store.close();
    const owner = worker('hold', dir); const ownerMsg = await message(owner.child); assert.equal(ownerMsg.readOnly, false);
    const reader = worker('open', dir); const done = once(reader.child, 'exit'); const result = await message(reader.child); await done;
    assert.deepEqual(result, { readOnly: true, rejected: true });
    const ownerDone = once(owner.child, 'exit'); owner.child.send('close'); await ownerDone;
    return { repo: dir, posts: 20, revisions: count, batchMs, separateProcesses: result };
  } finally { await store.close(); }
});
check('5 SIGKILL atomicity x50 and torn JSONL tail', async () => {
  const { dir, store, story, post, postFile } = await populated('crash'); await store.close();
  let old = 0, fresh = 0, temporaryFileAtKill = 0;
  const delays: number[] = [];
  const postDir = path.dirname(postFile);
  for (let i = 0; i < 50; i++) {
    await atomicJsonWrite(postFile, { ...post, error: 'OLD' });
    const { child } = worker('crash', dir, story.id, post.id);
    const ready = await message(child); assert.equal(ready.ready, true);
    const writing = message(child); child.send('write'); assert.equal((await writing).writing, true);
    const delay = randomInt(0, 21); delays.push(delay);
    await new Promise(r => setTimeout(r, delay));
    const names = await fs.readdir(postDir); if (names.some(n => n.endsWith('.tmp'))) temporaryFileAtKill++;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    const disk = Post.parse(JSON.parse(await fs.readFile(postFile, 'utf8')));
    if (disk.error === 'OLD') old++; else { assert.equal(disk.error, 'NEW:' + 'x'.repeat(1024 * 1024)); fresh++; }
    // Reopen must reclaim the dead writer's lock on every iteration.
    const reopened = await openProject(dir); assert.equal(reopened.readOnly, false); await reopened.close();
    for (const name of await fs.readdir(postDir)) if (name.endsWith('.tmp')) await fs.unlink(path.join(postDir, name));
  }
  assert.ok(old > 0 && fresh > 0, 'exercise both old and new outcomes');
  const s = await openProject(dir);
  try {
    await s.addRevision(story.id, post.id, { parts: ['complete'], author: 'user' });
    const jsonl = path.join(postDir, 'revisions.jsonl'); await fs.appendFile(jsonl, '{"id":"torn');
    const result = await s.readRevisions(story.id, post.id);
    assert.equal(result.revisions.length, 1); assert.equal(result.tornTail, true); assert.equal(result.ignoredTailBytes, 11);
    await assert.rejects(s.addRevision(story.id, post.id, { parts: ['blocked'], author: 'user' }), /Torn revision tail/);
    return { repo: dir, iterations: 50, old, new: fresh, temporaryFileAtKill, delaysMs: delays, deadLocksReclaimed: 50, tornTail: result.tornTail, ignoredTailBytes: result.ignoredTailBytes };
  } finally { await s.close(); }
});
check('6 migration backs up once and validates', async () => {
  const { dir, store, story, post, postFile } = await populated('migration');
  try {
    const v1 = { ...post, schemaVersion: 1, media: [{ assetSha: 'a'.repeat(64), alt: 'screenshot' }] };
    await atomicJsonWrite(postFile, v1);
    const migrated = await store.migrate(story.id, post.id);
    assert.equal(migrated.migrated, true); assert.equal(migrated.post.schemaVersion, 2); assert.equal(migrated.post.media[0].sha, 'a'.repeat(64));
    assert.deepEqual(JSON.parse(await fs.readFile(migrated.backup!, 'utf8')), v1);
    const second = await store.readPost(story.id, post.id); assert.deepEqual(second, migrated.post);
    const backups = await fs.readdir(path.dirname(migrated.backup!)); assert.equal(backups.length, 1);
    return { repo: dir, backup: migrated.backup, backupCount: 1, diskSchemaVersion: JSON.parse(await fs.readFile(postFile, 'utf8')).schemaVersion };
  } finally { await store.close(); }
});
check('7 moved repo preserves project identity', async () => {
  const { dir, store } = await populated('before-move'); const original = store.project; await store.close();
  const moved = path.join(run, 'after-move'); await fs.rename(dir, moved);
  const reopened = await openProject(moved);
  try { assert.equal(reopened.project.id, original.id); assert.equal(reopened.project.rootCommit, original.rootCommit); return { from: dir, to: moved, id: original.id, rootCommit: original.rootCommit }; }
  finally { await reopened.close(); }
});
check('8 stash/checkout preserve; clean -fdx deletes data', async () => {
  const { dir, store } = await populated('git-workflows'); const projectFile = path.join(store.root, 'project.json'); const before = await fs.readFile(projectFile, 'utf8'); await store.close();
  await fs.writeFile(path.join(dir, 'untracked.txt'), 'stash me'); await git(dir, 'stash', 'push', '-u', '-m', 'scratch');
  assert.equal(await fs.readFile(projectFile, 'utf8'), before);
  await git(dir, 'branch', 'other'); await git(dir, 'checkout', 'other'); assert.equal(await fs.readFile(projectFile, 'utf8'), before);
  const cleanOutput = await git(dir, 'clean', '-fdx'); await assert.rejects(fs.access(path.join(dir, '.bip')), { code: 'ENOENT' });
  return { repo: dir, stashU: 'preserved', checkout: 'preserved', cleanFdx: cleanOutput, dataLossConfirmed: true };
});
check('9 equal assets dedupe across extensions and are read-only', async () => {
  const { dir, store } = await populated('assets');
  try {
    const one = path.join(dir, 'a.png'), two = path.join(dir, 'b.jpg'); await fs.writeFile(one, 'identical bytes'); await fs.writeFile(two, 'identical bytes');
    const [a, b] = await Promise.all([store.putAsset(one), store.putAsset(two)]);
    assert.equal(a.path, b.path); const files = await fs.readdir(path.join(store.root, 'assets')); assert.equal(files.length, 1);
    assert.equal((await fs.stat(a.path)).mode & 0o222, 0);
    return { repo: dir, sha: a.sha, storedFiles: files.length, mode: ((await fs.stat(a.path)).mode & 0o777).toString(8) };
  } finally { await store.close(); }
});
check('10 latency sequential durable operations', async () => {
  const { dir, store, story, post } = await populated('latency');
  try {
    const creates: number[] = [], revisions: number[] = [];
    for (let i = 0; i < 100; i++) { let t = performance.now(); await store.createPost(story.id, { platform: 'linkedin' }); creates.push(performance.now() - t); t = performance.now(); await store.addRevision(story.id, post.id, { parts: [`sample ${i}`], author: 'user' }); revisions.push(performance.now() - t); }
    function stats(values: number[]) { const sorted = values.toSorted((a,b) => a-b); return { n: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5)-1], p95Ms: sorted[Math.ceil(sorted.length * .95)-1], samplesMs: values }; }
    return { repo: dir, createPost: stats(creates), addRevision: stats(revisions), method: '100 sequential operations each, performance.now wall time including fsync, warm filesystem cache' };
  } finally { await store.close(); }
});
check('11 readonly migrations, invalid schemas, symlinks and closed handles', async () => {
  const { dir, store, story, post, postFile } = await populated('guards');
  try {
    const v1 = { ...post, schemaVersion: 1, media: [] }; await atomicJsonWrite(postFile, v1);
    const reader = await openProject(dir); assert.equal(reader.readOnly, true);
    const migrated = await reader.migrate(story.id, post.id); assert.equal(migrated.persisted, false); assert.equal(migrated.post.schemaVersion, 2);
    assert.equal(JSON.parse(await fs.readFile(postFile, 'utf8')).schemaVersion, 1);
    await assert.rejects(reader.putAsset(path.join(dir, 'README.md')), /read-only/); await reader.close();
    await atomicJsonWrite(postFile, { ...post, platform: 'invalid' }); await assert.rejects(store.readPost(story.id, post.id));
    await assert.rejects(store.readPost('../escape', post.id));
    const outside = path.join(run, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(store.root, 'assets'));
    await assert.rejects(store.putAsset(path.join(dir, 'README.md')), /Symlink/); assert.deepEqual(await fs.readdir(outside), []);
    await store.close(); await assert.rejects(store.createStory({ title: 'closed' }), /closed/);
    return { repo: dir, readonlyMigrationWrites: 0, schemaRejected: true, pathEscapeRejected: true, symlinkRejected: true, closedWriteRejected: true };
  } finally { await store.close(); }
});
check('12 shared worktree opt-in coupling keeps private data ignored', async () => {
  const main = path.join(run, 'main'), wt = path.join(run, 'worktree');
  const a = await openProject(main), b = await openProject(wt);
  try {
    await a.optInCommitContext();
    const peerStatus = await git(wt, 'status', '--porcelain', '--untracked-files=all');
    assert.deepEqual(peerStatus.split('\n').sort(), ['?? .bip/.gitignore', '?? .bip/context.md']);
    assert.equal(b.project.commitContext, false);
    await b.optOut();
    const mainStatus = await git(main, 'status', '--porcelain', '--untracked-files=all');
    assert.equal(mainStatus, ''); assert.equal(a.project.commitContext, true);
    return { peerStatusDespiteOptOutSetting: peerStatus, mainStatusAfterPeerOptOut: mainStatus,
      caveat: 'Common exclude toggles visibility across all worktrees. Per-checkout settings are not independent; private data remains ignored.' };
  } finally { await a.close(); await b.close(); }
});
check('13 unborn repo stays clean and learns its first root commit', async () => {
  const dir = path.join(run, 'unborn'); await fs.mkdir(dir); await git(dir, 'init', '-b', 'main');
  const store = await openProject(dir); const projectId = store.project.id;
  try {
    assert.equal(store.project.rootCommit, '');
    await store.createStory({ title: 'Before first commit' });
    assert.equal(await git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  } finally { await store.close(); }
  await fs.writeFile(path.join(dir, 'README.md'), 'first'); await git(dir, 'add', 'README.md');
  await git(dir, '-c', 'user.name=Spike', '-c', 'user.email=spike@example.invalid', 'commit', '-m', 'first');
  const reopened = await openProject(dir);
  try {
    assert.equal(reopened.project.id, projectId); assert.equal(reopened.project.rootCommit, await git(dir, 'rev-parse', 'HEAD'));
    Project.parse(reopened.project);
    return { repo: dir, id: projectId, rootCommit: reopened.project.rootCommit, gitStatus: await git(dir, 'status', '--porcelain') };
  } finally { await reopened.close(); }
});
after(async () => { evidence.completedAt = new Date().toISOString(); await fs.mkdir(path.join(here, 'out'), { recursive: true }); await fs.writeFile(path.join(here, 'out/evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); });
