/** One detached owner per run; private local socket carries control commands. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RunControl } from './control.js';
import { runWorkflow } from './runner.js';

const dir = process.argv[2];
const control = new RunControl();
let socketDir;
let server;
let state;
const save = () => {
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
};
const stop = () => { if (state) { state.status = 'stopping'; save(); } control.cancel(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  const config = JSON.parse(await fsp.readFile(path.join(dir, 'config.json'), 'utf8'));
  socketDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cdw-'));
  const socket = path.join(socketDir, 'ctl');
  state = { runId: config.runId, status: 'starting', pid: process.pid, socket, agents: {}, phases: {}, startedAt: Date.now() };
  server = net.createServer(connection => {
    let buffer = '';
    connection.setTimeout(5000, () => connection.destroy());
    connection.on('error', () => {});
    connection.on('data', data => {
      buffer += data;
      if (buffer.length > 8192) return connection.destroy();
      if (!buffer.includes('\n')) return;
      try {
        const request = JSON.parse(buffer.split('\n')[0]);
        if (request.runId !== config.runId) throw new Error('runId 不匹配');
        if (!['running', 'paused', 'starting'].includes(state.status)) throw new Error('运行正在结束，不能控制');
        if (request.action === 'pause') { control.pause(); state.status = 'paused'; }
        else if (request.action === 'resume') { control.resume(); state.status = 'running'; }
        else if (request.action === 'cancel') {
          control.cancel(request.agentId);
          if (request.agentId === undefined) state.status = 'stopping';
        } else throw new Error('未知控制操作');
        save();
        connection.end(JSON.stringify({ runId: state.runId, status: state.status, agentId: request.agentId }) + '\n');
      } catch (e) { connection.end(JSON.stringify({ error: e.message }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await fsp.chmod(socket, 0o600);
  save();
  let notified = false;
  await runWorkflow({ ...config, control, onEvent(event) {
    const now = Date.now();
    if (event.type === 'run.started') {
      state.workflow = event.workflow;
      state.status = control.paused ? 'paused' : 'running';
      save();
      if (!notified) { notified = true; process.send?.({ runId: config.runId, status: state.status }); }
    }
    if (event.type === 'phase.started') state.phases[event.title] ??= { title: event.title, startedAt: now };
    if (event.agentId) {
      const agent = state.agents[event.agentId] ??= { agentId: event.agentId, seq: event.seq };
      if (event.type === 'agent.queued') Object.assign(agent, { status: 'queued', label: event.label, phase: event.phase, prompt: event.prompt });
      if (event.type === 'agent.started') Object.assign(agent, { status: 'running', startedAt: now, workDir: event.workDir });
      if (event.type === 'agent.event') {
        agent.recentEvent = JSON.stringify(event.event).slice(0, 4000);
        if (event.event.type === 'process.started') agent.pid = event.event.pid;
        if (event.event.type === 'process.exited') delete agent.pid;
      }
      if (['agent.completed', 'agent.failed', 'agent.cancelled'].includes(event.type)) {
        Object.assign(agent, { status: event.type.slice(6), durationMs: event.durationMs ?? now - (agent.startedAt ?? now), usage: event.usage });
        delete agent.pid;
      }
    }
    if (event.type === 'run.finished') {
      state.status = event.status;
      state.usage = event.usage;
      state.agentCount = event.agentCount;
      for (const agent of Object.values(state.agents)) {
        if (['queued', 'running'].includes(agent.status)) agent.status = 'stopped';
        delete agent.pid;
      }
    }
    state.updatedAt = now;
    save();
  }});
} catch (e) {
  if (state) { state.status = 'failed'; state.error = e.message; save(); }
  if (process.connected) process.send?.({ error: e.message });
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exitCode = 1;
} finally {
  control.cancel();
  if (server) await new Promise(resolve => server.close(resolve));
  if (socketDir) await fsp.rm(socketDir, { recursive: true, force: true });
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
}
