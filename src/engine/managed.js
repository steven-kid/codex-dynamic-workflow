/** Detached workflow lifecycle shared by CLI and MCP. No model work in clients. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveSource } from './runner.js';
import { compileScript } from './script.js';
import { transcriptRoot, workflowDirs, agentDirs, findProjectRoot, codexHome } from '../util/paths.js';

export function runDirectory(cwd, runId, root = transcriptRoot(cwd)) {
  if (!/^wf_[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('非法 runId');
  return path.join(root, runId);
}
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export async function status(cwd, runId, root) {
  const dir = runDirectory(cwd, runId, root);
  try {
    const summary = await readJson(path.join(dir, 'summary.json'));
    const state = await readJson(path.join(dir, 'state.json')).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
    return { ...state, ...summary };
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = await readJson(path.join(dir, 'state.json'));
  if (!alive(state.pid) && ['starting', 'running', 'paused', 'stopping'].includes(state.status)) {
    return { ...state, status: 'interrupted', error: '后台进程已退出；恢复前检查未退出的 agent 进程' };
  }
  return state;
}
export async function listRuns(cwd, limit = 20, root = transcriptRoot(cwd)) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const results = [];
  for (const entry of dirs) {
    if (!entry.isDirectory() || !/^wf_[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    try { results.push(await status(cwd, entry.name, root)); }
    catch { results.push({ runId: entry.name, status: 'incomplete' }); }
  }
  return results.sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, limit);
}

export async function startBackground(input) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const root = path.resolve(input.transcriptRoot ?? transcriptRoot(cwd));
  const source = await resolveSource({ ...input, cwd, workflowDirs: input.workflowDirs ?? workflowDirs(cwd) });
  const { meta } = compileScript(source.text, { filename: source.filename });
  // Validate dispatch parameters before creating a detached process.
  if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1)) throw new Error('concurrency 必须是正整数');
  if (input.budget != null && (!Number.isFinite(input.budget) || input.budget < 0)) throw new Error('budget 必须是非负有限数值');
  let resumeLock;
  if (input.resumeFromRunId) {
    const prior = runDirectory(cwd, input.resumeFromRunId, root);
    const state = await readJson(path.join(prior, 'state.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (state && (alive(state.pid) || Object.values(state.agents ?? {}).some(a => alive(a.pid)))) {
      throw new Error('原运行或其 agent 进程尚未退出，不能重放；暂停的运行请使用 resume');
    }
    await fs.access(path.join(prior, 'summary.json')); // Unclean exits require inspection, never automatic replay.
    resumeLock = path.join(prior, 'relaunch.json');
    try { const lock = await fs.open(resumeLock, 'wx', 0o600); await lock.close(); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('该运行已发起过恢复，请查看 relaunch.json 中的新 runId'); throw e; }
  }
  const runId = `wf_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const dir = runDirectory(cwd, runId, root);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const { signal, onEvent, control, ...serializable } = input;
    const config = { ...serializable, script: source.text, scriptPath: undefined, workflowName: undefined,
      cwd, runId, transcriptRoot: root, workflowDirs: input.workflowDirs ?? workflowDirs(cwd),
      agentDirs: input.agentDirs ?? agentDirs(cwd) };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const log = await fs.open(path.join(dir, 'worker.log'), 'a', 0o600);
    let child;
    try {
      child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [dir], {
        detached: true, cwd, stdio: ['ignore', log.fd, log.fd, 'ipc'], execArgv: [],
      });
    } finally { await log.close(); }
    let ready;
    try {
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`后台启动超时，请检查 ${dir}/worker.log`)); }, 15000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`后台进程退出 ${code}，请检查 ${dir}/worker.log`)); });
      child.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message); });
    });
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
    if (resumeLock) await fs.writeFile(resumeLock, JSON.stringify({ runId }), { mode: 0o600 });
    return { ...ready, workflow: meta.name, transcriptDir: dir };
  } catch (e) {
    // A startup error may have occurred after dispatch. Keep the reservation;
    // guessing that nothing ran could replay writes.
    if (resumeLock) await fs.writeFile(resumeLock, JSON.stringify({ runId, error: e.message }));
    throw e;
  }
}

export async function controlRun(cwd, runId, action, agentId, root) {
  if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('未知控制操作');
  const dir = runDirectory(cwd, runId, root);
  const state = await readJson(path.join(dir, 'state.json'));
  if (!alive(state.pid) || !state.socket) throw new Error('运行已退出，不能使用实时控制');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(state.socket);
    let data = '';
    const finish = (err, value) => { socket.destroy(); err ? reject(err) : resolve(value); };
    socket.setTimeout(5000, () => finish(new Error('控制请求超时，请先查询运行状态')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ runId, action, agentId }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) return finish(new Error('控制响应过大'));
      if (!data.includes('\n')) return;
      try { const reply = JSON.parse(data.split('\n')[0]); finish(reply.error ? new Error(reply.error) : null, reply); }
      catch (e) { finish(e); }
    });
    socket.on('end', () => { if (!data.includes('\n')) finish(new Error('控制连接提前关闭，请查询状态')); });
  });
}

export async function resumeRun(cwd, runId, overrides = {}) {
  const root = overrides.transcriptRoot ?? transcriptRoot(cwd);
  const current = await status(cwd, runId, root);
  if (['running', 'paused'].includes(current.status)) return controlRun(cwd, runId, 'resume', undefined, root);
  const config = await readJson(path.join(runDirectory(cwd, runId, root), 'config.json'));
  return startBackground({ ...config, ...overrides, cwd, resumeFromRunId: runId });
}

export async function saveRun(cwd, runId, name, personal = false) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('名称只能包含字母、数字、下划线和连字符');
  const text = await fs.readFile(path.join(runDirectory(cwd, runId), 'workflow.js'), 'utf8');
  const { meta } = compileScript(text);
  // Keep the original body exactly; metadata is rebuilt as a literal.
  const { parseMeta } = await import('./script.js');
  const parsed = parseMeta(text);
  const source = `export const meta = ${JSON.stringify({ ...meta, name }, null, 2)};\n${parsed.body}`;
  compileScript(source);
  const base = personal ? codexHome() : path.join(findProjectRoot(cwd), '.codex');
  const targetDir = path.join(base, 'workflows');
  // Reject existing symlink components, including .codex, before creating files.
  for (let p = targetDir; p !== path.dirname(base); p = path.dirname(p)) {
    const stat = await fs.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isSymbolicLink()) throw new Error(`不能通过符号链接保存 workflow: ${p}`);
  }
  await fs.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, `${name}.js`);
  await fs.writeFile(target, source, { flag: 'wx', mode: 0o600 });
  return { name, scriptPath: target };
}
