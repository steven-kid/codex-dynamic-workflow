#!/usr/bin/env node
// Opt-in, billable smoke test against an installed plugin and real Codex CLI.
// Usage: node scripts/smoke-managed-real.mjs <installed-plugin-root> <output-dir>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [pluginArg, outputArg] = process.argv.slice(2);
if (!pluginArg || !outputArg) throw new Error('Expected installed plugin root and output directory');
const plugin = path.resolve(pluginArg);
const output = path.resolve(outputArg);
const { startBackground, status, controlRun, saveRun } = await import(pathToFileURL(path.join(plugin, 'src/engine/managed.js')));
await fs.mkdir(output, { recursive: true });
const cwd = await fs.mkdtemp(path.join(output, 'project-'));
await fs.mkdir(path.join(cwd, '.codex'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(200); }
  throw new Error('Real smoke test exceeded 10 minutes');
};
let run;
try {
  run = await startBackground({ cwd, concurrency: 1, maxRetries: 0, sandbox: 'read-only',
    script: `export const meta = {name:'managed-real-smoke',description:'Two real model responses with pause/resume'};
    return await parallel([
      () => agent('Do not use tools. Reply exactly CDW_REAL_FIRST_OK.'),
      () => agent('Do not use tools. Return exactly {"ok":true}.', {schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}})
    ]);` });
  console.log(JSON.stringify({ started: run, cwd }));
  await until(async () => {
    const s = await status(cwd, run.runId);
    if (s.status === 'failed') throw new Error(JSON.stringify(s.error));
    return Object.values(s.agents ?? {}).some(a => a.pid);
  });
  await controlRun(cwd, run.runId, 'pause');
  const paused = await until(async () => {
    const s = await status(cwd, run.runId);
    if (s.status === 'failed') throw new Error(JSON.stringify(s.error));
    const first = Object.values(s.agents ?? {}).find(a => a.seq === 0);
    if (first?.status === 'failed') throw new Error('First real agent failed');
    return first?.status === 'completed' ? s : null;
  });
  assert.equal(paused.status, 'paused');
  assert.equal(Object.values(paused.agents).find(a => a.seq === 1).status, 'queued');
  console.log('PASS: first real call completed while second stayed paused');
  const saved = await saveRun(cwd, run.runId, 'managed-real-saved');
  await controlRun(cwd, run.runId, 'resume');
  const final = await until(async () => { const s = await status(cwd, run.runId); return s.journalFile ? s : null; });
  assert.equal(final.status, 'ok');
  assert.deepEqual(final.result, ['CDW_REAL_FIRST_OK', { ok: true }]);
  assert.equal(final.agentCount, 2);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ plugin, cwd, paused, saved, final }, null, 2));
  console.log('PASS: installed plugin background/pause/resume/save, real text and schema responses');
} finally {
  if (run) await controlRun(cwd, run.runId, 'cancel').catch(() => {});
}
