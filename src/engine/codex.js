import { strictOutputSchema } from './schema.js';
/**
 * Codex CLI 适配层：把一次 agent() 调用翻译成一次 `codex exec --json` 子进程，
 * 并把 JSONL thread events 解析成引擎内部事件。
 *
 * 事件协议（codex-cli 0.153.x，codex-rs/exec/src/exec_events.rs）：
 *   thread.started   { thread_id }
 *   turn.started     {}
 *   turn.completed   { usage: { input_tokens, cached_input_tokens,
 *                               cache_write_input_tokens?, output_tokens,
 *                               reasoning_output_tokens } }
 *   turn.failed      { error: { message } }
 *   item.started|updated|completed { item: { id, type, ...扁平字段 } }
 *   error            { message }
 *
 * item.type: agent_message(text) / reasoning(text) / command_execution /
 *            file_change / mcp_tool_call / collab_tool_call / web_search / todo_list / error
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { AgentError, WorkflowAbortError } from './errors.js';

/** 把一行 JSONL 解析成事件对象，非 JSON 行（codex 的 tracing 日志）返回 null */
export function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 累积 usage，字段缺失按 0 处理（cache_write_input_tokens 在旧版本可能没有） */
export function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
  };
}

export function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

export function addUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

/**
 * 构造 codex exec 参数。抽成纯函数，方便单测断言。
 */
export function buildCodexArgs({
  cwd,
  model,
  effort,
  sandbox,
  schemaPath,
  lastMessagePath,
  addDirs = [],
  configOverrides = {},
  skipGitRepoCheck = true,
  fullAuto = false,
  resumeThreadId,
}) {
  const args = ['exec', '--json'];

  if (resumeThreadId) args.push('resume', resumeThreadId);
  if (model) args.push('--model', model);
  if (sandbox) args.push('--sandbox', sandbox);
  if (cwd) args.push('--cd', cwd);
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (fullAuto) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (lastMessagePath) args.push('--output-last-message', lastMessagePath);

  const overrides = { ...configOverrides };
  // reasoning effort 通过 config override 注入，exec 没有独立 flag
  if (effort) overrides.model_reasoning_effort = effort;

  for (const [key, value] of Object.entries(overrides)) {
    args.push('-c', `${key}=${serializeTomlValue(value)}`);
  }

  // prompt 从 stdin 传入，避免超长 prompt 撑爆 argv
  args.push('-');
  return args;
}

/** -c key=value 的 value 以 TOML 解析，字符串要带引号 */
function serializeTomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(JSON.stringify(value));
}

/**
 * 跑一次 codex exec，返回 { finalText, threadId, usage, items, rawEvents }。
 *
 * onEvent 会收到每一条已解析的事件，用于驱动进度展示与 journal 落盘。
 */
export async function runCodexExec({
  prompt,
  cwd,
  codexBin = process.env.CDW_CODEX_BIN || 'codex',
  model,
  effort,
  sandbox = 'workspace-write',
  schema,
  addDirs,
  configOverrides,
  fullAuto,
  resumeThreadId,
  timeoutMs,
  signal,
  onEvent = () => {},
  env = process.env,
  keepTempFiles = false,
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdw-agent-'));
  const transportSchema = strictOutputSchema(schema);
  const schemaPath = transportSchema ? path.join(tempDir, 'schema.json') : undefined;
  const lastMessagePath = path.join(tempDir, 'last-message.txt');

  try {
    if (transportSchema) await fs.writeFile(schemaPath, JSON.stringify(transportSchema, null, 2), 'utf8');

    const args = buildCodexArgs({
      cwd,
      model,
      effort,
      sandbox,
      schemaPath,
      lastMessagePath,
      addDirs,
      configOverrides,
      fullAuto,
      resumeThreadId,
    });

    const child = spawn(codexBin, args, {
      cwd: cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const state = {
      threadId: null,
      usage: emptyUsage(),
      agentMessages: [],
      items: [],
      errors: [],
      stderr: [],
    };

    const kill = signalName => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch (err) {
        // Some hosts deny process-group signals; still stop our direct child.
        if (err.code === 'EPERM') {
          if (child.exitCode === null && child.signalCode === null) child.kill(signalName);
        } else if (err.code !== 'ESRCH') throw err;
      }
    };
    let killTimer;
    const abortHandler = () => {
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    if (signal) {
      if (signal.aborted) {
        abortHandler();
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill('SIGKILL');
        }, timeoutMs)
      : null;

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdoutLines.on('line', (line) => {
      const event = parseEventLine(line);
      if (!event) return;
      applyEvent(state, event);
      onEvent(event);
    });

    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrLines.on('line', (line) => {
      // codex 会把 tracing 日志写到 stderr，只保留尾部若干行用于报错
      state.stderr.push(line);
      if (state.stderr.length > 50) state.stderr.shift();
    });

    let exitCode;
    try {
      [exitCode] = await once(child, 'close');
    } finally {
      if (timer) clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); kill('SIGKILL'); }
      if (signal) signal.removeEventListener('abort', abortHandler);
    }

    if (signal?.aborted) throw new WorkflowAbortError('run 已中止');
    if (timedOut) {
      throw new AgentError(`agent 超时（${timeoutMs}ms）`, { exitCode: null });
    }

    // 优先用 --output-last-message 的内容：它就是最后一条 agent_message，
    // 天然规避 codex#19816（turn 内中间消息也被 schema 约束）。
    let finalText = await readIfExists(lastMessagePath);
    if (!finalText) finalText = state.agentMessages.at(-1) ?? '';

    if (exitCode !== 0) {
      const detail = state.errors.at(-1) ?? state.stderr.slice(-8).join('\n') ?? '';
      throw new AgentError(`codex exec 退出码 ${exitCode}${detail ? `: ${detail}` : ''}`, {
        exitCode,
      });
    }

    if (state.errors.length > 0 && !finalText) {
      throw new AgentError(`codex 执行失败: ${state.errors.at(-1)}`, { exitCode });
    }

    return {
      finalText: finalText.trim(),
      threadId: state.threadId,
      usage: state.usage,
      items: state.items,
      exitCode,
    };
  } finally {
    if (!keepTempFiles) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'thread.started':
      state.threadId = event.thread_id ?? state.threadId;
      break;
    case 'turn.completed':
      state.usage = addUsage(state.usage, normalizeUsage(event.usage));
      break;
    case 'turn.failed':
      if (event.error?.message) state.errors.push(event.error.message);
      break;
    case 'error':
      if (event.message) state.errors.push(event.message);
      break;
    case 'item.completed': {
      const item = event.item;
      if (!item) break;
      state.items.push(item);
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        state.agentMessages.push(item.text);
      }
      if (item.type === 'error' && item.message) state.errors.push(item.message);
      break;
    }
    default:
      break;
  }
}

async function readIfExists(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}
