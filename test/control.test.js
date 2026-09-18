import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunControl } from '../src/engine/control.js';
import { runWorkflow } from '../src/engine/runner.js';

const fake = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function setup(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cdw-control-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const codexBin = path.join(cwd, 'codex');
  await fs.writeFile(codexBin, `#!/bin/sh\nexport CDW_FAKE_DELAY_MS=120\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o755 });
  return { cwd, codexBin, transcriptRoot: path.join(cwd, 'runs'), maxRetries: 0, concurrency: 1 };
}
const script = `export const meta = {name:'controls',description:'test'};
return await parallel([() => agent('A'), () => agent('B'), () => agent('C')]);`;

test('pause drains active calls, blocks queued calls, resume completes without replay', { timeout: 5000 }, async t => {
  const options = await setup(t);
  const control = new RunControl();
  t.after(() => control.cancel());
  const events = [];
  let firstDone;
  const done = new Promise(resolve => { firstDone = resolve; });
  const pending = runWorkflow({ ...options, script, control, onEvent(e) {
    events.push(e);
    if (e.type === 'agent.event' && e.seq === 0 && e.event.type === 'thread.started') control.pause();
    if (e.type === 'agent.completed' && e.seq === 0) firstDone();
  }});
  await done;
  await sleep(80);
  assert.equal(events.filter(e => e.type === 'agent.started').length, 1);
  control.resume();
  const result = await pending;
  assert.deepEqual(result.result, ['echo:A', 'echo:B', 'echo:C']);
  assert.equal(result.agentCount, 3);
});

test('cancel a queued agent returns null, leaves siblings running, breaks resume prefix', { timeout: 5000 }, async t => {
  const options = await setup(t);
  const control = new RunControl();
  const result = await runWorkflow({ ...options, script, control, onEvent(e) {
    if (e.type === 'agent.queued' && e.seq === 1) control.cancel(e.agentId);
  }});
  assert.deepEqual(result.result, ['echo:A', null, 'echo:C']);
  const events = [];
  const resumed = await runWorkflow({ ...options, script, resumeDir: result.transcriptDir, onEvent: e => events.push(e) });
  assert.deepEqual(resumed.result, ['echo:A', 'echo:B', 'echo:C']);
  assert.deepEqual(events.filter(e => e.type === 'agent.cached').map(e => e.seq), [0]);
});

test('cancel a running agent stops its process and does not retry it', { timeout: 5000 }, async t => {
  const options = await setup(t);
  const control = new RunControl();
  const events = [];
  const summary = await runWorkflow({ ...options, script, control, onEvent(e) {
    events.push(e);
    if (e.type === 'agent.started' && e.seq === 0) setTimeout(() => control.cancel(e.agentId), 40);
  }});
  assert.deepEqual(summary.result, [null, 'echo:B', 'echo:C']);
  assert.equal(events.filter(e => e.type === 'agent.retry').length, 0);
});

test('whole-run cancellation releases paused and queued agents', { timeout: 5000 }, async t => {
  const options = await setup(t);
  const control = new RunControl();
  control.pause();
  const pending = runWorkflow({ ...options, script, control, onEvent(e) {
    if (e.type === 'agent.queued' && e.seq === 2) control.cancel();
  }});
  await assert.rejects(pending, /中止/);
  assert.equal(control.agents.size, 0);
});
