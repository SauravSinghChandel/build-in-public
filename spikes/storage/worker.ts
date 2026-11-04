import { openProject, atomicJsonWrite } from './store.ts';
const [mode, repo, ...args] = process.argv.slice(2);
if (mode === 'open') {
  const store = await openProject(repo);
  let rejected = false;
  try { await store.createStory({ title: 'must be rejected' }); } catch (e) { rejected = /read-only/.test(String(e)); }
  process.send?.({ readOnly: store.readOnly, rejected });
  await store.close(); process.disconnect?.();
} else if (mode === 'hold') {
  const store = await openProject(repo);
  process.send?.({ readOnly: store.readOnly });
  process.on('message', async () => { await store.close(); process.disconnect?.(); });
} else if (mode === 'crash') {
  const store = await openProject(repo);
  const post = await store.readPost(args[0], args[1]);
  post.error = 'NEW:' + 'x'.repeat(1024 * 1024);
  process.send?.({ ready: true });
  process.on('message', async () => {
    process.send?.({ writing: true });
    await atomicJsonWrite(`${store.root}/stories/${args[0]}/posts/${args[1]}/post.json`, post);
    process.send?.({ written: true });
    // Keep the writer and its lock alive until SIGKILL, even after rename.
  });
} else { throw Error('Unknown worker mode'); }
