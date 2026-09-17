/**
 * CLI 实现。刻意不引第三方依赖，保持插件零 npm 依赖、可直接 clone 使用。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { runWorkflow, resolveSource } from './engine/runner.js';
import { defaultConcurrency } from './engine/constants.js';
import { parseMeta } from './engine/script.js';
import { loadAgentRegistry } from './engine/agents.js';
import { agentDirs, listWorkflowFiles, transcriptRoot, workflowDirs } from './util/paths.js';
import { ProgressReporter } from './util/progress.js';

const USAGE = `cdw —— Codex Dynamic Workflow

用法:
  cdw run <script.js|-> [选项]     执行一个 workflow 脚本（- 表示从 stdin 读）
  cdw run --name <name> [选项]     执行一个命名 workflow
  cdw list                         列出所有可用的命名 workflow
  cdw show <name>                  查看某个 workflow 的 meta 与源码路径
  cdw agents                       列出可用的 agentType
  cdw runs [--limit N]             列出历史 run
  cdw resume <runId> [选项]        从历史 run 恢复（需配合 --script/--name）
  cdw validate <script.js>         只做语法与 meta 校验，不执行
  cdw mcp                          以 MCP stdio server 方式运行

选项:
  --args <json>          传给脚本的 args（JSON 字面量或 @文件路径）
  --budget <n>           output token 派发阈值，超出后 agent() 抛错
  --concurrency <n>      并发 agent 上限，默认 min(16, cpu-2)
  --model <model>        默认模型，可被 agent opts.model 覆盖
  --effort <level>       默认推理档位: minimal|low|medium|high|xhigh
  --sandbox <mode>       codex 沙箱: read-only|workspace-write|danger-full-access
  --cwd <dir>            工作目录，默认当前目录
  --dry-run              不调用模型，用占位结果验证脚本控制流
  --json                 以 JSON 输出最终结果
  --quiet                不渲染进度树
  --full-auto            给子 agent 加 --dangerously-bypass-approvals-and-sandbox
`;

export async function main(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return;
    case 'run':
      return cmdRun(parseArgs(rest));
    case 'list':
      return cmdList();
    case 'show':
      return cmdShow(rest[0]);
    case 'agents':
      return cmdAgents();
    case 'runs':
      return cmdRuns(parseArgs(rest));
    case 'resume':
      return cmdResume(rest[0], parseArgs(rest.slice(1)));
    case 'validate':
      return cmdValidate(rest[0]);
    case 'mcp': {
      const { startMcpServer } = await import('./mcp/server.js');
      return startMcpServer();
    }
    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

/** 极简参数解析：--key value / --flag / 位置参数 */
export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      opts._.push(token);
      continue;
    }
    const key = token.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) {
      opts[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
}

async function cmdRun(opts) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const positional = opts._[0];

  const source = await resolveRunSource(opts, positional);

  const args = await parseArgsValue(opts.args);
  const quiet = Boolean(opts.quiet) || Boolean(opts.json);
  const reporter = quiet ? null : new ProgressReporter();
  reporter?.start();

  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write('\n收到中断信号，正在停止 workflow…\n');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  try {
    const summary = await runWorkflow({
      ...source,
      args,
      cwd,
      concurrency: parseNumericOption(opts.concurrency, 'concurrency', {
        integer: true,
        min: 1,
        fallback: defaultConcurrency(),
      }),
      budget: parseNumericOption(opts.budget, 'budget', {
        integer: true,
        min: 0,
        fallback: null,
      }),
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      sandbox: opts.sandbox ?? undefined,
      fullAuto: Boolean(opts['full-auto']),
      dryRun: Boolean(opts['dry-run']),
      signal: controller.signal,
      transcriptRoot: transcriptRoot(cwd),
      workflowDirs: workflowDirs(cwd),
      agentDirs: agentDirs(cwd),
      resumeFromRunId: opts.resume ?? null,
      onEvent: (event) => reporter?.handle(event),
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (summary.result !== null && summary.result !== undefined) {
      process.stdout.write(`${formatResult(summary.result)}\n`);
    }
    if (summary.status !== 'ok') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    reporter?.stop();
  }
}

/**
 * 解析脚本来源。--script 与 --name、位置参数互斥，
 * 三者都没给才报错（`cdw resume <runId> --script ./wf.js` 依赖这里支持 --script）。
 */
async function resolveRunSource(opts, positional) {
  const script = typeof opts.script === 'string' ? opts.script : null;
  const provided = [
    script ? '--script' : null,
    opts.name ? '--name' : null,
    positional ? '位置参数' : null,
  ].filter(Boolean);

  if (provided.length > 1) {
    throw new Error(`${provided.join('、')} 不能同时使用，请只指定一个脚本来源`);
  }
  if (provided.length === 0) {
    throw new Error('请提供脚本路径，或用 --script / --name 指定脚本来源');
  }

  if (script) return { scriptPath: path.resolve(script) };
  if (opts.name) return { workflowName: opts.name };
  if (positional === '-') return { script: await readStdin() };
  return { scriptPath: path.resolve(positional) };
}

/**
 * 解析数值选项。非法值必须直接报错而不是放任 NaN 流下去：
 * NaN 并发会让信号量永久卡住（`0 < NaN` 恒为 false，没有任务能释放槽位），
 * NaN 预算会让所有比较为 false，等于静默关掉预算上限。
 */
export function parseNumericOption(raw, name, { integer = false, min, fallback } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === true) throw new Error(`--${name} 需要一个数值`);

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} 必须是有限数值，实际收到 "${raw}"`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`--${name} 必须是整数，实际收到 "${raw}"`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`--${name} 不能小于 ${min}，实际收到 "${raw}"`);
  }
  return value;
}

async function cmdResume(runId, opts) {
  if (!runId) throw new Error('请提供要恢复的 runId，例如 cdw resume wf_abc123 --script ./wf.js');
  return cmdRun({ ...opts, resume: runId });
}

async function cmdList() {
  const files = listWorkflowFiles();
  if (files.size === 0) {
    process.stdout.write('没有找到任何命名 workflow。\n搜索路径:\n');
    for (const dir of workflowDirs()) process.stdout.write(`  ${dir}\n`);
    return;
  }
  for (const [name, file] of files) {
    let description = '';
    try {
      const { meta } = parseMeta(await fsp.readFile(file, 'utf8'));
      description = meta.whenToUse ?? meta.description;
    } catch (err) {
      description = `<解析失败: ${err.message}>`;
    }
    process.stdout.write(`${name.padEnd(28)} ${description}\n`);
  }
}

async function cmdShow(name) {
  if (!name) throw new Error('请提供 workflow 名');
  const file = listWorkflowFiles().get(name);
  if (!file) throw new Error(`找不到 workflow "${name}"`);
  const { meta } = parseMeta(await fsp.readFile(file, 'utf8'));
  process.stdout.write(`${JSON.stringify({ ...meta, scriptPath: file }, null, 2)}\n`);
}

async function cmdAgents() {
  const registry = await loadAgentRegistry(agentDirs());
  for (const agent of registry.values()) {
    const tags = [agent.model, agent.effort, agent.sandbox].filter(Boolean).join(' · ');
    process.stdout.write(
      `${agent.name.padEnd(24)} ${agent.description}${tags ? `  [${tags}]` : ''}\n`,
    );
  }
}

async function cmdRuns(opts) {
  const root = transcriptRoot(path.resolve(opts.cwd ?? process.cwd()));
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    process.stdout.write(`还没有任何 run（${root} 不存在）\n`);
    return;
  }
  const limit = Number(opts.limit ?? 20);
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const summary = JSON.parse(
        await fsp.readFile(path.join(root, entry.name, 'summary.json'), 'utf8'),
      );
      runs.push(summary);
    } catch {
      runs.push({ runId: entry.name, status: 'incomplete', workflow: '?' });
    }
  }
  runs.sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
  for (const run of runs.slice(0, limit)) {
    process.stdout.write(
      `${run.runId.padEnd(20)} ${String(run.status).padEnd(16)} ${String(run.workflow).padEnd(24)} ${run.agentCount ?? '?'} agents\n`,
    );
  }
}

async function cmdValidate(target) {
  if (!target) throw new Error('请提供脚本路径');
  const source = await resolveSource({ scriptPath: path.resolve(target) });
  const { meta } = parseMeta(source.text);
  // compileScript 会做语法检查
  const { compileScript } = await import('./engine/script.js');
  compileScript(source.text, { filename: source.filename });
  process.stdout.write(`✔ ${meta.name} 校验通过\n`);
  if (meta.phases) {
    for (const phase of meta.phases) {
      process.stdout.write(`  ▸ ${phase.title}${phase.detail ? ` — ${phase.detail}` : ''}\n`);
    }
  }
}

function formatResult(result) {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

/** --args 支持内联 JSON、@file 与裸字符串 */
async function parseArgsValue(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith('@')) {
    return JSON.parse(await fsp.readFile(raw.slice(1), 'utf8'));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // 允许直接传一个字符串问题作为 args
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
