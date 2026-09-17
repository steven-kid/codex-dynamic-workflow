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
import { listWorkflowFiles, workflowDirs as defaultWorkflowDirs, agentDirs as defaultAgentDirs } from '../util/paths.js';
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
 * 把脚本 realm 里的返回值归一到宿主 realm。
 *
 * 脚本跑在独立 vm context 中（见 script.js），它构造的对象/数组原型来自那个 realm，
 * 宿主侧 `Array.isArray` 之外的判断（instanceof、deepStrictEqual）都会失真，
 * 消费方拿到的也是异原型对象。这里在引擎出口统一转成宿主 realm 的普通值。
 *
 * 不可结构化克隆的值（函数、Symbol 等）本就不该作为 workflow 结果，
 * 遇到时原样返回，交由 JSON 序列化环节暴露问题。
 */
function toHostRealm(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
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
    this.modelMap = options.modelMap ?? {};
    this.budgetBlocked = false;
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
    this.pendingAgents = new Set();
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

  assertRunnable({ checkLimit = true } = {}) {
    if (this.signal?.aborted) throw new WorkflowAbortError('run 已中止');
    if (this.budgetTotal !== null && this.spentOutputTokens >= this.budgetTotal) {
      this.budgetBlocked = true;
      throw new BudgetExhaustedError(
        `token 预算已用尽（${this.spentOutputTokens}/${this.budgetTotal} output tokens）`,
        { total: this.budgetTotal, spent: this.spentOutputTokens },
      );
    }
    if (checkLimit && this.agentCount >= MAX_AGENTS_PER_RUN) {
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
    agentDirs = defaultAgentDirs(cwd),
    workflowDirs = defaultWorkflowDirs(cwd),
    ...rest
  } = options;

  // 入口重复校验：即便调用方（CLI / MCP）漏校验，也不让 NaN 流进信号量与预算比较
  assertPositiveInt(concurrency, 'concurrency');
  if (budget !== null && budget !== undefined) assertNonNegativeNumber(budget, 'budget');

  const source = await resolveSource({ script, scriptPath, workflowName: workflowName ?? options.name, workflowDirs, cwd });
  const { meta, run } = compileScript(source.text, { filename: source.filename });

  const runId = makeRunId();
  const dir = path.join(transcriptRoot ?? path.join(cwd, '.codex', 'workflows'), runId);
  const journal = new Journal(dir);
  if (resumeFromRunId || resumeDir) {
    const priorDir =
      resumeDir ?? path.join(transcriptRoot ?? path.join(cwd, '.codex', 'workflows'), resumeFromRunId);
    const { loaded } = await journal.loadPrior(priorDir);
    onEvent({ type: 'run.resume', runId, from: resumeFromRunId ?? priorDir, cachedCalls: loaded });
  }

  await journal.init();

  // 脚本原文落盘：用户改脚本后可用 scriptPath + resumeFromRunId 续跑
  await fsp.writeFile(path.join(dir, 'workflow.js'), source.text, 'utf8');

  const registry = await loadAgentRegistry(agentDirs);

  const emit = (event) => {
    const enriched = { runId, ...event };
    journal.append({ kind: 'event', ...enriched });
    onEvent(enriched);
  };

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });

  const ctx = new RunContext({
    ...rest,
    runId,
    cwd,
    registry,
    journal,
    semaphore: new Semaphore(concurrency),
    signal: controller.signal,
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
    result = await run(buildHooks(ctx, { args, meta }));
  } catch (err) {
    status = err instanceof BudgetExhaustedError ? 'budget_exhausted' : 'failed';
    error = err;
  } finally {
    // Drain started/queued agents before closing journals or removing worktrees.
    controller.abort();
    await Promise.allSettled([...ctx.pendingAgents]);
    signal?.removeEventListener('abort', abort);
  }
  if (status === 'ok' && budget !== null && (ctx.spentOutputTokens > budget || ctx.budgetBlocked)) {
    status = 'budget_exhausted';
    error = new BudgetExhaustedError('token 预算已用尽（已运行请求可能超额）', { total: budget, spent: ctx.spentOutputTokens });
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
    result: toHostRealm(result ?? null),
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

/** 宿主钩子由 JSON bridge 调用；parallel/pipeline 在脚本上下文中执行。 */
function buildHooks(ctx, { args, meta }) {
  let currentPhase = null;

  const agent = async (prompt, opts = {}) => {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new WorkflowScriptError('agent opts 必须是对象');
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new WorkflowScriptError('agent(prompt) 的 prompt 必须是非空字符串');
    }
    const pending = runAgent(ctx, prompt, { ...opts, phase: opts.phase ?? currentPhase });
    ctx.pendingAgents.add(pending);
    try { return await pending; }
    finally { ctx.pendingAgents.delete(pending); }
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

  return { agent, phase, log, args, budget, workflow, meta, reportFailure: event => ctx.emit(event) };
}

/** 这些错误不能作为模型执行失败重试。分支如何收集错误由 script.js 决定。 */
function isFatal(err) {
  return (
    err instanceof WorkflowAbortError ||
    err instanceof BudgetExhaustedError ||
    err instanceof WorkflowLimitError ||
    err instanceof WorkflowScriptError
  );
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

  if (agentDef.unsupported?.length) {
    throw new WorkflowScriptError(`agentType "${agentType}" 包含尚不能等价映射的 Claude 配置：${agentDef.unsupported.join(', ')}；请提供 .codex/agents 下的适配定义`);
  }
  if (opts.isolation !== undefined && opts.isolation !== 'worktree') {
    throw new WorkflowScriptError('isolation 只支持 worktree');
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

  const schema = opts.schema !== undefined ? assertRootSchema(opts.schema) : null;
  const resolved = {
    phase: opts.phase ?? null,
    model: resolveModel(opts.model ?? agentDef.model, ctx.defaultModel, ctx.modelMap),
    effort: opts.effort ?? agentDef.effort ?? ctx.defaultEffort,
    sandbox: opts.sandbox ?? agentDef.sandbox ?? ctx.defaultSandbox,
    schema,
    agentType,
    agentSystemPrompt: agentDef.systemPrompt || null,
    isolation: opts.isolation ?? null,
    worktreeKey: opts.worktreeKey ?? null,
    cwd: path.resolve(opts.cwd ?? ctx.cwd),
    dryRun: ctx.dryRun,
    fullAuto: ctx.fullAuto,
  };
  const fp = fingerprint(buildAgentPrompt({ prompt, ...resolved }), resolved);

  // resume：命中最长未变前缀则直接返回历史结果
  // Isolated writes cannot be replayed from text alone: rerun until worktree
  // state is explicitly persisted/restored as part of the resume contract.
  if (resolved.isolation === 'worktree') ctx.journal.breakPrefix();
  const cached = ctx.journal.lookup(seq, fp);
  if (cached) {
    ctx.journal.append({ ...cached, seq, label, cached: true, usage: emptyUsage() });
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
        const key = opts.worktreeKey ? `${ctx.runId}-${opts.worktreeKey}` : agentId;
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
    let processFailures = 0;
    let schemaFailures = 0;

    // 两层重试：进程级失败走 maxRetries，schema 不合规走 schemaRetries
    const maxAttempts = 1 + ctx.maxRetries + (schema ? ctx.schemaRetries : 0);

    while (attempt < maxAttempts) {
      attempt += 1;
      ctx.assertRunnable({ checkLimit: false });

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
            if (schemaFailures++ >= ctx.schemaRetries) break;
            continue;
          }
          const check = validateAgainstSchema(parsed.value, schema);
          if (!check.valid) {
            correction = `上次输出不符合 schema：\n- ${check.errors.slice(0, 8).join('\n- ')}`;
            lastError = new AgentError(correction, { agentId, label });
            if (schemaFailures++ >= ctx.schemaRetries) break;
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
        if (processFailures++ >= ctx.maxRetries) break;
      }
    }

    const failure = new AgentError(
      `agent "${label}" 在 ${attempt} 次尝试后仍失败：${lastError?.message ?? '未知错误'}`,
      { agentId, label, attempts: attempt, cause: lastError },
    );
    ctx.journal.append({
      kind: 'agent',
      seq,
      agentId,
      label,
      fingerprint: fp,
      status: 'failed',
      attempts: attempt,
      error: failure.message,
      durationMs: Date.now() - startedAt,
    });
    ctx.emit({ type: 'agent.failed', seq, agentId, label, message: failure.message });
    return null;
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
    cwd,
  });
  const { meta, run } = compileScript(source.text, { filename: source.filename });

  const childDepth = ctx.depth + 1;
  ctx.emit({ type: 'workflow.child.started', name: meta.name });
  try {
    // 用 Proxy 而不是 Object.create：后者会让子 workflow 的 `ctx.agentCount += 1`
    // 写成自己的属性，把父级计数遮蔽掉，导致子 agent 不计入总数与预算。
    // Proxy 把所有读写都转发到同一个 ctx，只替换 emit。
    const childEmit = (event) => ctx.emit({ ...event, childWorkflow: meta.name });
    const childCtx = new Proxy(ctx, {
      get: (target, prop) => prop === 'depth' ? childDepth : (prop === 'emit' ? childEmit : Reflect.get(target, prop, target)),
      set: (target, prop, value) => Reflect.set(target, prop, value, target),
    });
    const result = await run(buildHooks(childCtx, { args: childArgs, meta }));
    ctx.emit({ type: 'workflow.child.finished', name: meta.name });
    return result;
  } finally {
    // Depth belongs to the child invocation, not the shared run.
  }
}

/** 解析脚本来源：内联 script / scriptPath / 命名 workflow */
export async function resolveSource({ script, scriptPath, workflowName, workflowDirs = [], cwd = process.cwd() }) {
  if (scriptPath) {
    const filename = path.resolve(cwd, scriptPath);
    return { text: await fsp.readFile(filename, 'utf8'), filename };
  }
  if (script) return { text: script, filename: 'inline-workflow.js' };
  if (workflowName) {
    const filename = listWorkflowFiles(cwd, workflowDirs).get(workflowName);
    if (filename) return { text: await fsp.readFile(filename, 'utf8'), filename };
    throw new WorkflowScriptError(`找不到名为 "${workflowName}" 的 workflow，已搜索：${workflowDirs.join(', ') || '(无)'}`);
  }
  throw new WorkflowScriptError('必须提供 script、scriptPath 或 workflowName 之一');
}

export function resolveModel(model, fallback, modelMap = {}) {
  const requested = !model || model === 'inherit' ? fallback : model;
  if (requested == null || requested === 'inherit') return null;
  const resolved = Object.hasOwn(modelMap, requested) ? modelMap[requested] : requested;
  if (typeof resolved !== 'string' || !resolved.trim()) throw new WorkflowScriptError('modelMap 的目标必须是非空 Codex 模型名');
  if (/^(?:opus|sonnet|haiku)(?:\[.*\])?$|^claude-/i.test(resolved)) {
    throw new WorkflowScriptError(`Claude 模型 "${requested}" 不能直接用于 Codex；请通过 modelMap 显式映射到可用的 Codex 模型`);
  }
  return resolved;
}

export { DEFAULT_AGENT };
