/**
 * Workflow 运行器：编排脚本执行、agent 派发、并发控制、预算、journal 与 resume。
 *
 * 核心语义（对齐 Claude Code Dynamic Workflow）：
 *  - agent(prompt, opts)      → 派发一个子 agent，有 schema 时返回校验过的对象，否则返回文本
 *  - parallel(thunks)         → 屏障：等齐所有结果；单个失败降级为 null，整体不 reject
 *  - pipeline(items, ...stages) → 无屏障流水线：每个 item 独立穿过所有 stage
 *  - phase(title) / log(msg)  → 进度分组与叙述
 *  - args / budget            → 入参与 token 预算
 *  - workflow(name|{scriptPath}, args) → 内联子 workflow，共享并发/计数/预算/中止信号
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { loadAgentRegistry, DEFAULT_AGENT } from './agents.js';
import { runCodexExec, emptyUsage, addUsage } from './codex.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_SCHEMA_RETRIES,
  EFFORT_LEVELS,
  MAX_AGENTS_PER_RUN,
  MAX_ITEMS_PER_CALL,
  MAX_WORKFLOW_DEPTH,
  SANDBOX_MODES,
  defaultConcurrency,
} from './constants.js';
import {
  AgentError,
  BudgetExhaustedError,
  WorkflowAbortError,
  WorkflowLimitError,
  WorkflowScriptError,
} from './errors.js';
import { Journal, fingerprint } from './journal.js';
import { buildAgentPrompt, defaultLabel } from './prompt.js';
import { assertRootSchema, extractJson, validateAgainstSchema } from './schema.js';
import { Semaphore } from './semaphore.js';
import { compileScript } from './script.js';
import { createWorktree, isGitRepo } from './worktree.js';

/** run id 生成：脚本里禁用了 Date.now/Math.random，但引擎自身可以用 */
function makeRunId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `wf_${stamp}${rand}`;
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkflowScriptError(`${name} 必须是 ≥1 的整数，实际收到 ${JSON.stringify(value)}`);
  }
}

function assertNonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new WorkflowScriptError(`${name} 必须是 ≥0 的有限数值，实际收到 ${JSON.stringify(value)}`);
  }
}

/**
 * 一次 workflow 执行的共享上下文。父子 workflow 共用同一个实例，
 * 因此并发槽位、agent 计数、预算、中止信号天然是全局的。
 */
class RunContext {
  constructor(options) {
    this.runId = options.runId;
    this.cwd = options.cwd;
    this.codexBin = options.codexBin;
    this.defaultModel = options.model ?? null;
    this.defaultEffort = options.effort ?? null;
    this.defaultSandbox = options.sandbox ?? 'workspace-write';
    this.fullAuto = options.fullAuto ?? false;
    this.agentTimeoutMs = options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.schemaRetries = options.schemaRetries ?? DEFAULT_SCHEMA_RETRIES;
    this.dryRun = options.dryRun ?? false;
    this.registry = options.registry;
    this.journal = options.journal;
    this.semaphore = options.semaphore;
    this.signal = options.signal;
    this.emit = options.emit;
    this.transcriptDir = options.transcriptDir;
    this.resolveWorkflow = options.resolveWorkflow;

    this.budgetTotal = options.budgetTotal ?? null;
    this.usage = emptyUsage();
    this.agentSeq = 0;
    this.agentCount = 0;
    this.depth = 0;
    this.worktrees = [];
    /** worktreeKey → createWorktree 的 promise，供多阶段复用同一份 worktree */
    this.worktreesByKey = new Map();
  }

  get spentOutputTokens() {
    return this.usage.outputTokens;
  }

  remainingBudget() {
    if (this.budgetTotal === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.budgetTotal - this.spentOutputTokens);
  }

  assertRunnable() {
    if (this.signal?.aborted) throw new WorkflowAbortError('run 已中止');
    if (this.budgetTotal !== null && this.spentOutputTokens >= this.budgetTotal) {
      throw new BudgetExhaustedError(
        `token 预算已用尽（${this.spentOutputTokens}/${this.budgetTotal} output tokens）`,
        { total: this.budgetTotal, spent: this.spentOutputTokens },
      );
    }
    if (this.agentCount >= MAX_AGENTS_PER_RUN) {
      throw new WorkflowLimitError(`单次 run 的 agent 总数已达上限 ${MAX_AGENTS_PER_RUN}`);
    }
  }
}

/**
 * 执行一个 workflow 脚本。
 *
 * @returns {Promise<{runId, result, usage, agentCount, transcriptDir, journalFile, meta}>}
 */
export async function runWorkflow(options) {
  const {
    script,
    scriptPath,
    workflowName,
    args,
    cwd = process.cwd(),
    concurrency = defaultConcurrency(),
    budget = null,
    signal,
    onEvent = () => {},
    transcriptRoot,
    resumeFromRunId = null,
    resumeDir = null,
    agentDirs = [],
    workflowDirs = [],
    ...rest
  } = options;

  // 入口重复校验：即便调用方（CLI / MCP）漏校验，也不让 NaN 流进信号量与预算比较
  assertPositiveInt(concurrency, 'concurrency');
  if (budget !== null && budget !== undefined) assertNonNegativeNumber(budget, 'budget');

  const source = await resolveSource({ script, scriptPath, workflowName, workflowDirs });
  const { meta, run } = compileScript(source.text, { filename: source.filename });

  const runId = makeRunId();
  const dir = path.join(transcriptRoot ?? path.join(cwd, '.codex', 'workflows'), runId);
  const journal = new Journal(dir);
  await journal.init();

  if (resumeFromRunId || resumeDir) {
    const priorDir =
      resumeDir ?? path.join(transcriptRoot ?? path.join(cwd, '.codex', 'workflows'), resumeFromRunId);
    const { loaded } = await journal.loadPrior(priorDir);
    onEvent({ type: 'run.resume', runId, from: resumeFromRunId ?? priorDir, cachedCalls: loaded });
  }

  // 脚本原文落盘：用户改脚本后可用 scriptPath + resumeFromRunId 续跑
  await fsp.writeFile(path.join(dir, 'workflow.js'), source.text, 'utf8');

  const registry = await loadAgentRegistry([
    ...agentDirs,
    path.join(cwd, '.codex', 'agents'),
    path.join(cwd, '.agents', 'agents'),
  ]);

  const emit = (event) => {
    const enriched = { runId, ...event };
    journal.append({ kind: 'event', ...enriched });
    onEvent(enriched);
  };

  const ctx = new RunContext({
    ...rest,
    runId,
    cwd,
    registry,
    journal,
    semaphore: new Semaphore(concurrency),
    signal,
    emit,
    transcriptDir: dir,
    budgetTotal: budget,
    resolveWorkflow: (nameOrRef, childArgs) =>
      runChildWorkflow({ ctx, nameOrRef, childArgs, workflowDirs, cwd }),
  });

  journal.append({
    kind: 'run.started',
    runId,
    workflow: meta.name,
    description: meta.description,
    concurrency,
    budget,
    args: args ?? null,
  });
  emit({ type: 'run.started', workflow: meta.name, meta, concurrency, budget });

  const startedAt = Date.now();
  let result;
  let status = 'ok';
  let error = null;

  try {
    result = await run(...buildHooks(ctx, { args, meta }));
  } catch (err) {
    status = err instanceof BudgetExhaustedError ? 'budget_exhausted' : 'failed';
    error = err;
  }

  // 清理无改动的 worktree（元素是 createWorktree 的 promise，可能尚未 settle）
  const worktreeSummary = [];
  for (const pending of ctx.worktrees) {
    try {
      const wt = await pending;
      worktreeSummary.push(await wt.finalize());
    } catch {
      /* 创建失败或清理失败都不影响结果 */
    }
  }

  const summary = {
    runId,
    workflow: meta.name,
    meta,
    status,
    result: status === 'ok' ? (result ?? null) : null,
    error: error ? { name: error.name, message: error.message } : null,
    usage: ctx.usage,
    agentCount: ctx.agentCount,
    durationMs: Date.now() - startedAt,
    transcriptDir: dir,
    journalFile: journal.file,
    worktrees: worktreeSummary.filter((w) => w.kept),
  };

  journal.append({ kind: 'run.finished', ...summary });
  emit({ type: 'run.finished', ...summary });
  await journal.close();
  await fsp.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  if (error && status !== 'budget_exhausted') throw error;
  return summary;
}

/** 组装注入给脚本的钩子，顺序必须与 script.js 里的 hookNames 一致 */
function buildHooks(ctx, { args, meta }) {
  let currentPhase = null;

  const agent = async (prompt, opts = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new WorkflowScriptError('agent(prompt) 的 prompt 必须是非空字符串');
    }
    return runAgent(ctx, prompt, { ...opts, phase: opts.phase ?? currentPhase });
  };

  const parallel = async (thunks) => {
    if (!Array.isArray(thunks)) throw new WorkflowScriptError('parallel(thunks) 需要一个数组');
    assertItemCount(thunks.length, 'parallel');
    // 屏障语义：等齐所有分支；单分支失败降级为 null，不让整体 reject
    return Promise.all(
      thunks.map(async (thunk, i) => {
        if (typeof thunk !== 'function') {
          throw new WorkflowScriptError(`parallel(thunks)[${i}] 必须是返回 Promise 的函数`);
        }
        try {
          return await thunk();
        } catch (err) {
          if (isFatal(err)) throw err;
          ctx.emit({ type: 'branch.failed', index: i, message: err.message });
          return null;
        }
      }),
    );
  };

  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new WorkflowScriptError('pipeline(items, ...) 需要一个数组');
    assertItemCount(items.length, 'pipeline');
    if (stages.length === 0) return items.slice();
    for (const [i, stage] of stages.entries()) {
      if (typeof stage !== 'function') {
        throw new WorkflowScriptError(`pipeline 的第 ${i + 1} 个 stage 必须是函数`);
      }
    }
    // 无屏障：每个 item 独立跑完所有 stage，item A 可以在 stage3 时 item B 还在 stage1
    return Promise.all(
      items.map(async (item, index) => {
        let value = item;
        for (const stage of stages) {
          try {
            value = await stage(value, item, index);
          } catch (err) {
            if (isFatal(err)) throw err;
            ctx.emit({ type: 'item.dropped', index, message: err.message });
            return null;
          }
        }
        return value;
      }),
    );
  };

  const phase = (title) => {
    if (typeof title !== 'string' || !title.trim()) {
      throw new WorkflowScriptError('phase(title) 需要一个非空字符串');
    }
    currentPhase = title;
    ctx.emit({ type: 'phase.started', title });
  };

  const log = (message) => {
    ctx.emit({ type: 'log', message: String(message) });
  };

  const budget = {
    get total() {
      return ctx.budgetTotal;
    },
    spent: () => ctx.spentOutputTokens,
    remaining: () => ctx.remainingBudget(),
  };

  const workflow = async (nameOrRef, childArgs) => {
    if (ctx.depth >= MAX_WORKFLOW_DEPTH) {
      throw new WorkflowScriptError(
        `workflow() 只支持 ${MAX_WORKFLOW_DEPTH} 层嵌套，子 workflow 内不能再调用 workflow()`,
      );
    }
    return ctx.resolveWorkflow(nameOrRef, childArgs);
  };

  return [agent, parallel, pipeline, phase, log, args, budget, workflow, meta];
}

/** 这些错误不该被 parallel/pipeline 吞掉，必须终止整个 run */
function isFatal(err) {
  return (
    err instanceof WorkflowAbortError ||
    err instanceof BudgetExhaustedError ||
    err instanceof WorkflowLimitError ||
    err instanceof WorkflowScriptError
  );
}

function assertItemCount(count, who) {
  if (count > MAX_ITEMS_PER_CALL) {
    throw new WorkflowLimitError(
      `单次 ${who}() 最多接受 ${MAX_ITEMS_PER_CALL} 个条目，实际 ${count}；请自行分批`,
    );
  }
}

/** 派发一个子 agent：并发槽 → 缓存 → worktree → codex exec → schema 校验 → 记账 */
async function runAgent(ctx, prompt, opts) {
  ctx.assertRunnable();

  const seq = ctx.agentSeq++;
  const label = opts.label ?? defaultLabel(prompt, seq);

  // 先把多级默认值解析完，再算指纹——指纹必须反映真正送给模型的输入，
  // 否则改了 phase / agent 定义 / run 级默认 model 之后 resume 会错误命中旧缓存
  const agentType = opts.agentType ?? 'general-purpose';
  const agentDef = ctx.registry.get(agentType);
  if (!agentDef) {
    const known = [...ctx.registry.keys()].join(', ');
    throw new WorkflowScriptError(`未知的 agentType "${agentType}"，可用：${known}`);
  }

  if (opts.effort && !EFFORT_LEVELS.includes(opts.effort)) {
    throw new WorkflowScriptError(
      `非法的 effort "${opts.effort}"，可选：${EFFORT_LEVELS.join(' | ')}`,
    );
  }
  if (opts.sandbox && !SANDBOX_MODES.includes(opts.sandbox)) {
    throw new WorkflowScriptError(
      `非法的 sandbox "${opts.sandbox}"，可选：${SANDBOX_MODES.join(' | ')}`,
    );
  }

  const schema = opts.schema ? assertRootSchema(opts.schema) : null;
  const resolved = {
    phase: opts.phase ?? null,
    model: opts.model ?? agentDef.model ?? ctx.defaultModel,
    effort: opts.effort ?? agentDef.effort ?? ctx.defaultEffort,
    sandbox: opts.sandbox ?? agentDef.sandbox ?? ctx.defaultSandbox,
    schema,
    agentType,
    agentSystemPrompt: agentDef.systemPrompt || null,
    isolation: opts.isolation ?? null,
    worktreeKey: opts.worktreeKey ?? null,
    cwd: opts.cwd ?? null,
  };
  const fp = fingerprint(prompt, resolved);

  // resume：命中最长未变前缀则直接返回历史结果
  const cached = ctx.journal.lookup(seq, fp);
  if (cached) {
    ctx.emit({ type: 'agent.cached', seq, label, phase: resolved.phase });
    return cached.result;
  }

  return ctx.semaphore.run(async () => {
    ctx.assertRunnable();
    ctx.agentCount += 1;

    const agentId = `${ctx.runId}-a${seq}`;
    let workDir = opts.cwd ?? ctx.cwd;
    let worktree = null;

    if (opts.isolation === 'worktree') {
      if (await isGitRepo(workDir)) {
        // 同一个 worktreeKey 的多个 agent 复用同一份 worktree，
        // 这样「改造 → 验证」这类多阶段流程里，后一阶段能看到前一阶段的实际改动。
        // 存 promise 而非结果，避免并发同 key 时重复创建。
        const key = opts.worktreeKey ?? agentId;
        let pending = ctx.worktreesByKey.get(key);
        if (!pending) {
          pending = createWorktree({ repoRoot: workDir, name: key });
          ctx.worktreesByKey.set(key, pending);
          ctx.worktrees.push(pending);
        }
        worktree = await pending;
        workDir = worktree.path;
      } else {
        ctx.emit({ type: 'warning', message: `${label}: 非 git 仓库，已忽略 worktree 隔离` });
      }
    }

    ctx.emit({
      type: 'agent.started',
      seq,
      agentId,
      label,
      phase: resolved.phase,
      agentType,
      model: resolved.model,
      effort: resolved.effort,
      isolation: resolved.isolation,
      workDir,
    });

    const startedAt = Date.now();
    let attempt = 0;
    let correction = null;
    let lastError = null;

    // 两层重试：进程级失败走 maxRetries，schema 不合规走 schemaRetries
    const maxAttempts = 1 + ctx.maxRetries + (schema ? ctx.schemaRetries : 0);

    while (attempt < maxAttempts) {
      attempt += 1;
      ctx.assertRunnable();

      try {
        const composed = buildAgentPrompt({
          prompt,
          schema,
          agentSystemPrompt: agentDef.systemPrompt,
          phase: resolved.phase,
          correction,
        });

        const execResult = ctx.dryRun
          ? dryRunResult(schema, label)
          : await runCodexExec({
              prompt: composed,
              cwd: workDir,
              codexBin: ctx.codexBin,
              model: resolved.model,
              effort: resolved.effort,
              sandbox: resolved.sandbox,
              schema,
              fullAuto: ctx.fullAuto,
              timeoutMs: opts.timeoutMs ?? ctx.agentTimeoutMs,
              signal: ctx.signal,
              onEvent: (event) =>
                ctx.emit({ type: 'agent.event', seq, agentId, label, event }),
            });

        ctx.usage = addUsage(ctx.usage, execResult.usage);

        let value = execResult.finalText;
        if (schema) {
          const parsed = extractJson(execResult.finalText);
          if (!parsed.ok) {
            correction = `上次输出无法解析为 JSON：${parsed.error}`;
            lastError = new AgentError(correction, { agentId, label });
            continue;
          }
          const check = validateAgainstSchema(parsed.value, schema);
          if (!check.valid) {
            correction = `上次输出不符合 schema：\n- ${check.errors.slice(0, 8).join('\n- ')}`;
            lastError = new AgentError(correction, { agentId, label });
            continue;
          }
          value = parsed.value;
        }

        const record = {
          kind: 'agent',
          seq,
          agentId,
          label,
          phase: resolved.phase,
          fingerprint: fp,
          status: 'ok',
          attempts: attempt,
          threadId: execResult.threadId,
          usage: execResult.usage,
          durationMs: Date.now() - startedAt,
          result: value,
        };
        ctx.journal.append(record);
        ctx.emit({
          type: 'agent.completed',
          seq,
          agentId,
          label,
          phase: resolved.phase,
          attempts: attempt,
          usage: execResult.usage,
          durationMs: record.durationMs,
        });
        return value;
      } catch (err) {
        if (isFatal(err)) throw err;
        lastError = err;
        ctx.emit({
          type: 'agent.retry',
          seq,
          agentId,
          label,
          attempt,
          maxAttempts,
          message: err.message,
        });
      }
    }

    const failure = new AgentError(
      `agent "${label}" 在 ${maxAttempts} 次尝试后仍失败：${lastError?.message ?? '未知错误'}`,
      { agentId, label, attempts: maxAttempts, cause: lastError },
    );
    ctx.journal.append({
      kind: 'agent',
      seq,
      agentId,
      label,
      fingerprint: fp,
      status: 'failed',
      attempts: maxAttempts,
      error: failure.message,
      durationMs: Date.now() - startedAt,
    });
    ctx.emit({ type: 'agent.failed', seq, agentId, label, message: failure.message });
    throw failure;
  });
}

/** dry-run：不调模型，产出占位结果，用来验证脚本控制流 */
function dryRunResult(schema, label) {
  const text = schema
    ? JSON.stringify(synthesize(schema))
    : `[dry-run] ${label} 未真实调用 codex`;
  return { finalText: text, threadId: null, usage: emptyUsage(), items: [], exitCode: 0 };
}

/** 按 schema 生成一份最小合法样例，供 dry-run 使用 */
function synthesize(schema) {
  const types = [].concat(schema.type ?? 'object');
  const type = types[0];
  switch (type) {
    case 'object': {
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        out[key] = synthesize(sub);
      }
      return out;
    }
    case 'array':
      return schema.items ? [synthesize(schema.items)] : [];
    case 'string':
      return schema.enum?.[0] ?? 'dry-run';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/** 内联执行子 workflow：共享 ctx 的并发/计数/预算/中止信号 */
async function runChildWorkflow({ ctx, nameOrRef, childArgs, workflowDirs, cwd }) {
  const source = await resolveSource({
    scriptPath: typeof nameOrRef === 'object' ? nameOrRef.scriptPath : undefined,
    workflowName: typeof nameOrRef === 'string' ? nameOrRef : undefined,
    workflowDirs,
  });
  const { meta, run } = compileScript(source.text, { filename: source.filename });

  ctx.depth += 1;
  ctx.emit({ type: 'workflow.child.started', name: meta.name });
  try {
    // 用 Proxy 而不是 Object.create：后者会让子 workflow 的 `ctx.agentCount += 1`
    // 写成自己的属性，把父级计数遮蔽掉，导致子 agent 不计入总数与预算。
    // Proxy 把所有读写都转发到同一个 ctx，只替换 emit。
    const childEmit = (event) => ctx.emit({ ...event, childWorkflow: meta.name });
    const childCtx = new Proxy(ctx, {
      get: (target, prop) => (prop === 'emit' ? childEmit : Reflect.get(target, prop, target)),
      set: (target, prop, value) => Reflect.set(target, prop, value, target),
    });
    const result = await run(...buildHooks(childCtx, { args: childArgs, meta }));
    ctx.emit({ type: 'workflow.child.finished', name: meta.name });
    return result;
  } finally {
    ctx.depth -= 1;
  }
}

/** 解析脚本来源：内联 script / scriptPath / 命名 workflow */
export async function resolveSource({ script, scriptPath, workflowName, workflowDirs = [] }) {
  if (script) return { text: script, filename: 'inline-workflow.js' };

  if (scriptPath) {
    const text = await fsp.readFile(scriptPath, 'utf8');
    return { text, filename: scriptPath };
  }

  if (workflowName) {
    for (const dir of workflowDirs) {
      const candidate = path.join(dir, `${workflowName}.js`);
      try {
        const text = await fsp.readFile(candidate, 'utf8');
        return { text, filename: candidate };
      } catch {
        /* 下一个目录 */
      }
    }
    throw new WorkflowScriptError(
      `找不到名为 "${workflowName}" 的 workflow，已搜索：${workflowDirs.join(', ') || '(无)'}`,
    );
  }

  throw new WorkflowScriptError('必须提供 script、scriptPath 或 workflowName 之一');
}

export { DEFAULT_AGENT };
