/**
 * Codex Dynamic Workflow MCP server。
 *
 * 暴露给 Codex 主 agent 的工具：
 *   workflow_run      —— 执行一个内联脚本 / 脚本文件 / 命名 workflow
 *   workflow_list     —— 列出命名 workflow
 *   workflow_validate —— 只校验脚本，不执行
 *   workflow_runs     —— 列出历史 run，便于 resume
 *   workflow_inspect  —— 读取某次 run 的 journal，排查「为什么返回空」
 *
 * 注意：真正跑 workflow 会拉起多个 codex 子进程，消耗可观。
 * 触发门槛写在工具 description 里，由主 agent 的系统提示与用户显式授权共同把关。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { loadAgentRegistry } from '../engine/agents.js';
import { defaultConcurrency } from '../engine/constants.js';
import { parseMeta } from '../engine/script.js';
import { compileScript } from '../engine/script.js';
import { runWorkflow } from '../engine/runner.js';
import { agentDirs, listWorkflowFiles, transcriptRoot, workflowDirs } from '../util/paths.js';
import { McpServer, textResult } from './protocol.js';

const SCRIPT_GUIDE = `workflow 脚本是一段 JavaScript（不是 TypeScript），必须以纯字面量 meta 开头：

export const meta = {
  name: 'find-flaky-tests',
  description: '找出不稳定测试并给出修复建议',
  phases: [{ title: 'Scan' }, { title: 'Fix' }],
}

脚本体在 async 上下文中运行，可直接 await。可用钩子：
  agent(prompt, opts?)        派发子 agent。opts: {label, phase, schema, model, effort, sandbox, agentType, isolation:'worktree', worktreeKey, timeoutMs, cwd}
                              同 worktreeKey 的多个 agent 共用一份 worktree（多阶段需读同一份改动时必须带）
                              带 schema 时返回校验过的对象，否则返回字符串；失败返回 null（在 parallel/pipeline 内）
  parallel(thunks)            屏障：等齐全部；单个失败降级为 null，需 .filter(Boolean)
  pipeline(items, ...stages)  无屏障流水线，默认首选；stage 签名 (prev, originalItem, index)
  phase(title) / log(msg)     进度分组与叙述
  args                        调用方传入的参数
  budget                      {total, spent(), remaining()}，total 为 null 表示不限
  workflow(nameOrRef, args)   内联子 workflow，仅支持一层嵌套

禁止使用 Date.now() / new Date() / Math.random()（会破坏 resume 确定性），
脚本跑在独立 vm context 中，只有 JS 语言内建能力：无 fetch、无 process、无 require、无 setTimeout、不能 import 模块，I/O 交给子 agent 做。脚本的 return 值即为 workflow 结果。`;

export function createServer({ cwd = process.cwd() } = {}) {
  const server = new McpServer({ name: 'codex-dynamic-workflow', version: '0.1.0' });

  server.registerTool({
    name: 'workflow_run',
    description: `执行一个 Dynamic Workflow：用确定性 JS 脚本编排多个 codex 子 agent（fan-out、流水线、对抗式校验、预算循环）。

仅在用户明确要求多 agent 编排时调用——例如说了「用 workflow 跑」「并行铺开 agent」「orchestrate」，或调用了某个已保存的命名 workflow。一次调用可能拉起数十个 codex 子进程，成本高，不要为普通任务自作主张调用。

${SCRIPT_GUIDE}`,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '内联 workflow 脚本源码（与 scriptPath/name 三选一）' },
        scriptPath: { type: 'string', description: '脚本文件路径；每次运行都会把脚本存档，便于改后续跑' },
        name: { type: 'string', description: '命名 workflow（见 workflow_list）' },
        args: { description: '传给脚本的 args，原样透传，可以是任意 JSON 值' },
        cwd: { type: 'string', description: '工作目录，默认当前目录' },
        budget: { type: 'number', description: 'output token 预算上限；用尽后 agent() 抛错' },
        concurrency: { type: 'number', description: `并发 agent 上限，默认 ${defaultConcurrency()}` },
        model: { type: 'string', description: '默认模型，可被脚本内 opts.model 覆盖' },
        effort: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          description: '默认推理档位',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: '子 agent 的 codex 沙箱模式，默认 workspace-write',
        },
        dryRun: { type: 'boolean', description: '不调模型，用占位结果验证控制流' },
        resumeFromRunId: { type: 'string', description: '从历史 run 恢复：未变更的调用前缀直接复用缓存' },
      },
      additionalProperties: false,
    },
    handler: async (input, { sendProgress }) => {
      const workDir = path.resolve(input.cwd ?? cwd);
      const narration = [];

      const summary = await runWorkflow({
        script: input.script,
        scriptPath: input.scriptPath,
        workflowName: input.name,
        args: input.args,
        cwd: workDir,
        budget: input.budget ?? null,
        concurrency: input.concurrency ?? defaultConcurrency(),
        model: input.model ?? null,
        effort: input.effort ?? null,
        sandbox: input.sandbox,
        dryRun: Boolean(input.dryRun),
        resumeFromRunId: input.resumeFromRunId ?? null,
        transcriptRoot: transcriptRoot(workDir),
        workflowDirs: workflowDirs(workDir),
        agentDirs: agentDirs(workDir),
        onEvent: (event) => {
          const line = describeEvent(event);
          if (!line) return;
          narration.push(line);
          sendProgress(line);
        },
      });

      const payload = {
        runId: summary.runId,
        workflow: summary.workflow,
        status: summary.status,
        result: summary.result,
        agentCount: summary.agentCount,
        usage: summary.usage,
        durationMs: summary.durationMs,
        transcriptDir: summary.transcriptDir,
        journalFile: summary.journalFile,
        worktrees: summary.worktrees,
        error: summary.error,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: summary.status !== 'ok',
      };
    },
  });

  server.registerTool({
    name: 'workflow_list',
    description: '列出所有可用的命名 workflow（插件内置 + $CODEX_HOME/workflows + 项目 .codex/workflows）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const files = listWorkflowFiles(cwd);
      const items = [];
      for (const [name, file] of files) {
        try {
          const { meta } = parseMeta(await fsp.readFile(file, 'utf8'));
          items.push({
            name,
            description: meta.description,
            whenToUse: meta.whenToUse ?? null,
            phases: meta.phases?.map((p) => p.title) ?? [],
            scriptPath: file,
          });
        } catch (err) {
          items.push({ name, error: err.message, scriptPath: file });
        }
      }
      const agents = [...(await loadAgentRegistry(agentDirs(cwd))).values()].map((a) => ({
        name: a.name,
        description: a.description,
      }));
      const payload = { workflows: items, agentTypes: agents };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  });

  server.registerTool({
    name: 'workflow_validate',
    description: '校验一段 workflow 脚本的 meta 与语法，不执行任何 agent。写完脚本先跑这个，比直接执行便宜得多。',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string' },
        scriptPath: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const text = input.script ?? (await fsp.readFile(input.scriptPath, 'utf8'));
      const { meta } = compileScript(text, { filename: input.scriptPath ?? 'inline.js' });
      return textResult(`✔ ${meta.name} 校验通过\n${JSON.stringify(meta, null, 2)}`);
    },
  });

  server.registerTool({
    name: 'workflow_runs',
    description: '列出历史 run 及其状态，用于找到可 resume 的 runId',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 20' },
        cwd: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const root = transcriptRoot(path.resolve(input.cwd ?? cwd));
      const runs = await readRuns(root, input.limit ?? 20);
      return {
        content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }],
        structuredContent: { runs },
      };
    },
  });

  server.registerTool({
    name: 'workflow_inspect',
    description:
      '读取某次 run 的 journal.jsonl，查看每个 agent 的实际返回值。当 workflow 返回空或结果不符预期时，先看这个再下结论。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        cwd: { type: 'string' },
        maxEntries: { type: 'number', description: '最多返回多少条 agent 记录，默认 50' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async (input) => {
      const root = transcriptRoot(path.resolve(input.cwd ?? cwd));
      const file = path.join(root, input.runId, 'journal.jsonl');
      const raw = await fsp.readFile(file, 'utf8');
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.kind === 'agent')
        .slice(0, input.maxEntries ?? 50)
        .map((e) => ({
          seq: e.seq,
          label: e.label,
          phase: e.phase,
          status: e.status,
          attempts: e.attempts,
          durationMs: e.durationMs,
          outputTokens: e.usage?.outputTokens ?? 0,
          result: truncate(e.result),
          error: e.error ?? null,
        }));
      return {
        content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
        structuredContent: { runId: input.runId, entries },
      };
    },
  });

  return server;
}

export function startMcpServer(options) {
  const server = createServer(options);
  server.listen();
  return server;
}

/** 把引擎事件压成一行人话，用作 MCP 进度通知 */
export function describeEvent(event) {
  switch (event.type) {
    case 'run.started':
      return `▶ ${event.workflow} 启动（并发 ${event.concurrency}）`;
    case 'phase.started':
      return `▸ ${event.title}`;
    case 'log':
      return `· ${event.message}`;
    case 'agent.started':
      return `◐ ${event.label}`;
    case 'agent.completed':
      return `✔ ${event.label}（${event.durationMs}ms）`;
    case 'agent.cached':
      return `⟲ ${event.label} 命中缓存`;
    case 'agent.failed':
      return `✘ ${event.label}: ${event.message}`;
    case 'run.finished':
      return `${event.status === 'ok' ? '✔' : '✘'} ${event.workflow} ${event.status} · ${event.agentCount} agents`;
    default:
      return null;
  }
}

async function readRuns(root, limit) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const summary = JSON.parse(
        await fsp.readFile(path.join(root, entry.name, 'summary.json'), 'utf8'),
      );
      runs.push({
        runId: summary.runId,
        workflow: summary.workflow,
        status: summary.status,
        agentCount: summary.agentCount,
        durationMs: summary.durationMs,
      });
    } catch {
      runs.push({ runId: entry.name, status: 'incomplete' });
    }
  }
  return runs.sort((a, b) => String(b.runId).localeCompare(String(a.runId))).slice(0, limit);
}

function truncate(value, max = 2000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > max ? `${text.slice(0, max)}…（已截断，完整内容见 journal）` : value;
}
