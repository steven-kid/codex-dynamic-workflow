import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startBackground, status, controlRun, resumeRun, saveRun, listRuns, alive } from '../src/engine/managed.js';
import { compileScript } from '../src/engine/script.js';

const fake = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
const cli = fileURLToPath(new URL('../bin/cdw.js', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = `export const meta = {name:'managed',description:'test'}; return await parallel([() => agent('A'), () => agent('B'), () => agent('C')]);`;
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20); }
  throw new Error('condition timed out');
}
async function setup(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cdw-managed-'));
  await fs.mkdir(path.join(cwd, '.codex'));
  const codexBin = path.join(cwd, 'codex');
  await fs.writeFile(codexBin, `#!/bin/sh\nexport CDW_FAKE_DELAY_MS=400\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o755 });
  t.after(async () => {
    for (const run of await listRuns(cwd)) {
      if (['running', 'paused', 'starting'].includes(run.status)) await controlRun(cwd, run.runId, 'cancel').catch(() => {});
    }
    await until(async () => (await listRuns(cwd)).every(run => !['running', 'paused', 'starting', 'stopping'].includes(run.status)));
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { cwd, codexBin, script, concurrency: 1, maxRetries: 0, sandbox: 'read-only' };
}
const finished = (cwd, id) => until(async () => {
  const result = await status(cwd, id);
  return ['ok', 'failed', 'budget_exhausted'].includes(result.status) && result.journalFile ? result : null;
});

test('detached controls persist status, drain pause, resume, and save reusable script', { timeout: 15000 }, async t => {
  const input = await setup(t);
  const started = await startBackground(input);
  assert.ok(started.runId);
  await until(async () => Object.values((await status(input.cwd, started.runId)).agents ?? {}).some(a => a.pid));
  await controlRun(input.cwd, started.runId, 'pause');
  await until(async () => Object.values((await status(input.cwd, started.runId)).agents ?? {}).some(a => a.status === 'completed'));
  await sleep(80);
  const paused = await status(input.cwd, started.runId);
  assert.equal(paused.status, 'paused');
  assert.equal(Object.values(paused.agents).filter(a => a.status === 'completed').length, 1);
  assert.equal((await listRuns(input.cwd))[0].status, 'paused');
  const saved = await saveRun(input.cwd, started.runId, 'saved-demo');
  assert.equal(compileScript(await fs.readFile(saved.scriptPath, 'utf8')).meta.name, 'saved-demo');
  await assert.rejects(saveRun(input.cwd, started.runId, 'saved-demo'), /EEXIST/);
  await assert.rejects(saveRun(input.cwd, started.runId, '../escape'), /名称/);
  await resumeRun(input.cwd, started.runId);
  const result = await finished(input.cwd, started.runId);
  assert.deepEqual(result.result, ['echo:A', 'echo:B', 'echo:C']);
});

test('targeted cancel kills process, returns null; stopped run relaunch restores args and caches', { timeout: 15000 }, async t => {
  const input = await setup(t);
  const started = await startBackground({ ...input, args: ['A','B','C'], script: `export const meta = {name:'args-test',description:'test'}; return await parallel(args.map(p=>()=>agent(p)));` });
  const active = await until(async () => Object.values((await status(input.cwd, started.runId)).agents ?? {}).find(a => a.seq === 1 && a.pid));
  await assert.rejects(startBackground({ ...input, resumeFromRunId: started.runId }), /尚未退出/);
  await controlRun(input.cwd, started.runId, 'cancel', active.agentId);
  const done = await finished(input.cwd, started.runId);
  assert.deepEqual(done.result, ['echo:A', null, 'echo:C']);
  assert.equal(alive(active.pid), false);
  const state = JSON.parse(await fs.readFile(path.join(done.transcriptDir, 'state.json')));
  await until(() => !alive(state.pid));
  const next = await resumeRun(input.cwd, started.runId);
  const resumed = await finished(input.cwd, next.runId);
  assert.deepEqual(resumed.result, ['echo:A','echo:B','echo:C']);
  assert.equal(resumed.agentCount, 2);
  await assert.rejects(resumeRun(input.cwd, started.runId), /已发起过恢复/);
});

test('CLI exits while worker continues; whole-run cancel drains processes', { timeout: 15000 }, async t => {
  const input = await setup(t);
  const file = path.join(input.cwd, 'test.js');
  await fs.writeFile(file, script);
  const child = spawn(process.execPath, [cli, 'run', file, '--cwd', input.cwd, '--background', '--json', '--concurrency', '1'], {
    env: { ...process.env, CDW_CODEX_BIN: input.codexBin }, stdio: ['ignore','pipe','pipe'],
  });
  let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, stderr);
  const started = JSON.parse(output);
  const active = await until(async () => Object.values((await status(input.cwd, started.runId)).agents ?? {}).find(a => a.pid));
  await controlRun(input.cwd, started.runId, 'pause');
  await controlRun(input.cwd, started.runId, 'cancel');
  const stopped = await finished(input.cwd, started.runId);
  assert.equal(stopped.status, 'failed');
  assert.equal(alive(active.pid), false);
  await assert.rejects(status(input.cwd, '../escape'), /非法 runId/);
});

test('save rejects symlink directories and bad scripts fail before dispatch', { timeout: 15000 }, async t => {
  const input = await setup(t);
  await assert.rejects(startBackground({ ...input, script: 'broken' }), /meta/);
  const run = await startBackground({ ...input, dryRun: true });
  await finished(input.cwd, run.runId);
  const outside = path.join(input.cwd, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(input.cwd, '.codex', 'workflows'));
  await assert.rejects(saveRun(input.cwd, run.runId, 'saved'), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});
