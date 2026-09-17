/**
 * 端到端集成测试：用 test/fixtures/fake-codex.js 替代真实 codex 二进制，
 * 真实拉起子进程、真实走 JSONL 事件解析，验证引擎语义。
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';

import { runWorkflow } from '../src/engine/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.join(HERE, 'fixtures', 'fake-codex.js');

let workDir;

before(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cdw-it-'));
});

after(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/** 桩不是可执行二进制，通过 node 包一层 */
async function makeCodexShim(dir, env = {}) {
  const shim = path.join(dir, 'codex-shim.sh');
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
    .join('\n');
  await fsp.writeFile(shim, `#!/bin/sh\n${exports}\nexec ${process.execPath} ${FAKE_CODEX} "$@"\n`);
  await fsp.chmod(shim, 0o755);
  return shim;
}

async function run(script, options = {}) {
  const dir = await fsp.mkdtemp(path.join(workDir, 'run-'));
  const codexBin = await makeCodexShim(dir, options.fakeEnv ?? {});
  const events = [];
  const summary = await runWorkflow({
    script,
    cwd: dir,
    codexBin,
    transcriptRoot: path.join(dir, 'runs'),
    concurrency: options.concurrency ?? 4,
    maxRetries: options.maxRetries ?? 0,
    onEvent: (e) => events.push(e),
    ...options.runOptions,
  });
  return { summary, events, dir };
}

test('单个 agent：返回文本、记账 usage、prompt 正确送达', async () => {
  const { summary, events } = await run(`export const meta = {
  name: 'single',
  description: '最小用例',
}
return await agent('说一句话')
`);

  assert.equal(summary.status, 'ok');
  assert.equal(summary.result, 'echo:说一句话');
  assert.equal(summary.agentCount, 1);
  assert.equal(summary.usage.outputTokens, 50);
  assert.equal(summary.usage.inputTokens, 100);
  assert.ok(events.some((e) => e.type === 'agent.completed'));
});

test('schema 模式：返回解析后的对象，且取最后一条 agent_message', async () => {
  const { summary } = await run(`export const meta = {
  name: 'structured',
  description: 'schema 用例',
}
return await agent('找出问题', {
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      count: { type: 'number' },
    },
  },
})
`);

  assert.equal(summary.status, 'ok');
  assert.equal(typeof summary.result, 'object');
  assert.equal(summary.result.count, 42);
  // 桩会先发一条 INTERMEDIATE 的 agent_message；取到 "找出问题" 说明取的是最后一条
  assert.equal(summary.result.title, '找出问题');
});

test('parallel 是屏障：等齐全部结果', async () => {
  const { summary } = await run(`export const meta = {
  name: 'par',
  description: 'parallel 用例',
}
const results = await parallel([
  () => agent('任务一'),
  () => agent('任务二'),
  () => agent('任务三'),
])
return results
`);
  assert.deepEqual(summary.result, ['echo:任务一', 'echo:任务二', 'echo:任务三']);
});

test('parallel 单分支失败降级为 null，整体不 reject', async () => {
  const { summary } = await run(
    `export const meta = {
  name: 'par-fail',
  description: '失败降级',
}
const results = await parallel([
  () => agent('好的任务'),
  () => { throw new Error('这个分支炸了') },
])
return results
`,
  );
  assert.equal(summary.status, 'ok');
  assert.equal(summary.result[0], 'echo:好的任务');
  assert.equal(summary.result[1], null);
});

test('agent 执行失败在 parallel 内降级为 null', async () => {
  const { summary } = await run(
    `export const meta = {
  name: 'agent-fail',
  description: 'agent 失败',
}
return await parallel([() => agent('必定失败')])
`,
    { fakeEnv: { CDW_FAKE_MODE: 'crash' } },
  );
  assert.equal(summary.status, 'ok');
  assert.deepEqual(summary.result, [null]);
});

test('pipeline 逐项穿过所有 stage，stage 收到 (prev, item, index)', async () => {
  const { summary } = await run(`export const meta = {
  name: 'pipe',
  description: 'pipeline 用例',
}
return await pipeline(
  ['alpha', 'beta'],
  (item) => agent('处理 ' + item),
  (prev, original, index) => ({ prev, original, index }),
)
`);
  assert.equal(summary.result.length, 2);
  assert.equal(summary.result[0].prev, 'echo:处理 alpha');
  assert.equal(summary.result[0].original, 'alpha');
  assert.equal(summary.result[1].index, 1);
});

test('pipeline 中某一项抛错时该项降级为 null，其余项不受影响', async () => {
  const { summary } = await run(`export const meta = {
  name: 'pipe-fail',
  description: 'pipeline 降级',
}
return await pipeline(
  ['ok', 'bad'],
  (item) => {
    if (item === 'bad') throw new Error('这一项炸了')
    return agent('处理 ' + item)
  },
)
`);
  assert.equal(summary.result[0], 'echo:处理 ok');
  assert.equal(summary.result[1], null);
});

test('schema 不合规会自动纠正重试一次', async () => {
  const { summary, events } = await run(
    `export const meta = {
  name: 'retry',
  description: 'schema 纠正',
}
return await agent('结构化任务', {
  schema: { type: 'object', properties: { title: { type: 'string' } } },
})
`,
    { fakeEnv: { CDW_FAKE_MODE: 'badschema' } },
  );
  assert.equal(summary.status, 'ok');
  assert.equal(summary.result.title, '结构化任务');
  const completed = events.find((e) => e.type === 'agent.completed');
  assert.equal(completed.attempts, 2, '应该在第二次尝试才成功');
});

test('预算循环超额时如实标记 budget_exhausted', async () => {
  const { summary } = await run(
    `export const meta = {
  name: 'budget-loop',
  description: '预算循环',
}
const out = []
while (budget.remaining() > 0) {
  out.push(await agent('再来一次'))
}
return { calls: out.length, remaining: budget.remaining() }
`,
    { runOptions: { budget: 120 } },
  );
  // 每个 agent 50 output tokens：跑 3 次后 spent=150，remaining 归零，循环退出
  assert.equal(summary.status, 'budget_exhausted');
  assert.equal(summary.agentCount, 3);
  assert.equal(summary.usage.outputTokens, 150);
  assert.deepEqual(summary.result, {calls:3,remaining:0});
});

test('预算派发阈值：用尽后再调 agent() 抛错，run 记为 budget_exhausted', async () => {
  const { summary } = await run(
    `export const meta = {
  name: 'budget-hard',
  description: '预算硬上限',
}
const out = []
// 刻意不看 remaining()，一路调到超出为止
for (let i = 0; i < 10; i += 1) {
  out.push(await agent('第 ' + i + ' 次'))
}
return out
`,
    { runOptions: { budget: 120 } },
  );
  assert.equal(summary.status, 'budget_exhausted');
  assert.equal(summary.result, null);
  assert.equal(summary.agentCount, 3, '第 4 次调用应在派发前就被预算拦截');
  assert.match(summary.error.message, /预算已用尽/);
});

test('budget.total 为 null 时 remaining() 是 Infinity', async () => {
  const { summary } = await run(`export const meta = {
  name: 'no-budget',
  description: '无预算',
}
return { total: budget.total, infinite: budget.remaining() === Infinity, spent: budget.spent() }
`);
  assert.equal(summary.result.total, null);
  assert.equal(summary.result.infinite, true);
});

test('phase 与 log 产生对应事件', async () => {
  const { events } = await run(`export const meta = {
  name: 'phases',
  description: '阶段',
  phases: [{ title: 'First' }],
}
phase('First')
log('开始了')
await agent('干活')
`);
  assert.ok(events.some((e) => e.type === 'phase.started' && e.title === 'First'));
  assert.ok(events.some((e) => e.type === 'log' && e.message === '开始了'));
  const started = events.find((e) => e.type === 'agent.started');
  assert.equal(started.phase, 'First', 'agent 应继承当前 phase');
});

test('opts.phase 覆盖当前 phase', async () => {
  const { events } = await run(`export const meta = {
  name: 'phase-override',
  description: '覆盖阶段',
}
phase('A')
await agent('干活', { phase: 'B' })
`);
  assert.equal(events.find((e) => e.type === 'agent.started').phase, 'B');
});

test('args 原样透传给脚本', async () => {
  const { summary } = await run(
    `export const meta = {
  name: 'args',
  description: '入参',
}
return { got: args, isArray: Array.isArray(args) }
`,
    { runOptions: { args: ['a.ts', 'b.ts'] } },
  );
  assert.deepEqual(summary.result.got, ['a.ts', 'b.ts']);
  assert.equal(summary.result.isArray, true);
});

test('并发受 concurrency 限制', async () => {
  const { events } = await run(
    `export const meta = {
  name: 'conc',
  description: '并发',
}
return await parallel(Array.from({ length: 8 }, (_, i) => () => agent('任务' + i)))
`,
    { concurrency: 2, fakeEnv: { CDW_FAKE_DELAY_MS: 40 } },
  );

  // 用 started/completed 事件重放并发峰值
  let active = 0;
  let peak = 0;
  for (const e of events) {
    if (e.type === 'agent.started') peak = Math.max(peak, (active += 1));
    if (e.type === 'agent.completed' || e.type === 'agent.failed') active -= 1;
  }
  assert.ok(peak <= 2, `并发峰值 ${peak} 应不超过 2`);
});

test('agentType 未知时报错', async () => {
  await assert.rejects(
    () =>
      run(`export const meta = {
  name: 'bad-agent',
  description: '未知 agent',
}
return await agent('干活', { agentType: 'nonexistent' })
`),
    /未知的 agentType/,
  );
});

test('自定义 agentType 的 system prompt 生效', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'agents-'));
  const agentDir = path.join(dir, 'myagents');
  await fsp.mkdir(agentDir, { recursive: true });
  await fsp.writeFile(
    path.join(agentDir, 'picky.md'),
    '---\nname: picky\ndescription: 挑剔的\neffort: high\n---\n\n你必须非常挑剔。',
  );
  const codexBin = await makeCodexShim(dir);

  const events = [];
  const summary = await runWorkflow({
    script: `export const meta = {
  name: 'custom-agent',
  description: '自定义 agent',
}
return await agent('审查', { agentType: 'picky' })
`,
    cwd: dir,
    codexBin,
    agentDirs: [agentDir],
    transcriptRoot: path.join(dir, 'runs'),
    onEvent: (e) => events.push(e),
  });

  assert.equal(summary.status, 'ok');
  const started = events.find((e) => e.type === 'agent.started');
  assert.equal(started.agentType, 'picky');
  assert.equal(started.effort, 'high', 'agent 定义里的 effort 应作为默认值生效');
});

test('dry-run 不拉起子进程，按 schema 产出占位结果', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'dry-'));
  const summary = await runWorkflow({
    script: `export const meta = {
  name: 'dry',
  description: '空跑',
}
return await agent('任务', { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } })
`,
    cwd: dir,
    codexBin: '/nonexistent/codex', // 真被调用就会 ENOENT
    dryRun: true,
    transcriptRoot: path.join(dir, 'runs'),
  });
  assert.equal(summary.status, 'ok');
  assert.deepEqual(summary.result, { ok: false });
  assert.equal(summary.usage.outputTokens, 0);
});

test('journal 记录每个 agent 的真实返回值', async () => {
  const { summary } = await run(`export const meta = {
  name: 'journal',
  description: '日志',
}
await agent('第一个')
await agent('第二个')
return 'done'
`);
  const raw = await fsp.readFile(summary.journalFile, 'utf8');
  const agents = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'agent');
  assert.equal(agents.length, 2);
  assert.equal(agents[0].result, 'echo:第一个');
  assert.equal(agents[1].seq, 1);
  assert.ok(agents[0].threadId, 'thread_id 应被记录');
});

test('resume 复用未变更前缀，改动处及之后重跑', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'resume-'));
  const codexBin = await makeCodexShim(dir);
  const transcriptRoot = path.join(dir, 'runs');

  const first = await runWorkflow({
    script: `export const meta = {
  name: 'resume-demo',
  description: '续跑',
}
const a = await agent('步骤一')
const b = await agent('步骤二')
return [a, b]
`,
    cwd: dir,
    codexBin,
    transcriptRoot,
  });
  assert.equal(first.agentCount, 2);

  // 只改第二个 agent 的 prompt：第一个应命中缓存
  const events = [];
  const second = await runWorkflow({
    script: `export const meta = {
  name: 'resume-demo',
  description: '续跑',
}
const a = await agent('步骤一')
const b = await agent('步骤二改了')
return [a, b]
`,
    cwd: dir,
    codexBin,
    transcriptRoot,
    resumeFromRunId: first.runId,
    onEvent: (e) => events.push(e),
  });

  assert.equal(second.agentCount, 1, '只有改动过的那个 agent 应真实执行');
  assert.equal(events.filter((e) => e.type === 'agent.cached').length, 1);
  assert.deepEqual(second.result, ['echo:步骤一', 'echo:步骤二改了']);
});

test('resume 脚本完全未变时 100% 命中缓存', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'resume2-'));
  const codexBin = await makeCodexShim(dir);
  const transcriptRoot = path.join(dir, 'runs');
  const script = `export const meta = {
  name: 'resume-full',
  description: '全量命中',
}
return await parallel([() => agent('一'), () => agent('二'), () => agent('三')])
`;

  const first = await runWorkflow({ script, cwd: dir, codexBin, transcriptRoot });
  const second = await runWorkflow({
    script,
    cwd: dir,
    codexBin,
    transcriptRoot,
    resumeFromRunId: first.runId,
  });

  assert.equal(second.agentCount, 0, '全部命中缓存，不应真实执行任何 agent');
  assert.deepEqual(second.result, first.result);
});

test('中止信号让 run 立即停止', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'abort-'));
  const codexBin = await makeCodexShim(dir, { CDW_FAKE_DELAY_MS: 500 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(
    () =>
      runWorkflow({
        script: `export const meta = {
  name: 'abort',
  description: '中止',
}
return await parallel([() => agent('慢活一'), () => agent('慢活二')])
`,
        cwd: dir,
        codexBin,
        transcriptRoot: path.join(dir, 'runs'),
        signal: controller.signal,
      }),
    /中止/,
  );
});

test('resume：仅 phase 变化也会让缓存失效并重跑', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'resume-phase-'));
  const codexBin = await makeCodexShim(dir);
  const transcriptRoot = path.join(dir, 'runs');

  const first = await runWorkflow({
    script: `export const meta = {
  name: 'resume-phase',
  description: 'phase 影响提示词',
}
phase('A')
return await agent('同一个任务')
`,
    cwd: dir,
    codexBin,
    transcriptRoot,
  });
  assert.equal(first.agentCount, 1);

  // prompt 没变，只改了 phase——但 phase 会被写进提示词，必须重跑
  const events = [];
  const second = await runWorkflow({
    script: `export const meta = {
  name: 'resume-phase',
  description: 'phase 影响提示词',
}
phase('B')
return await agent('同一个任务')
`,
    cwd: dir,
    codexBin,
    transcriptRoot,
    resumeFromRunId: first.runId,
    onEvent: (e) => events.push(e),
  });

  assert.equal(second.agentCount, 1, 'phase 变了就不该命中缓存');
  assert.equal(events.filter((e) => e.type === 'agent.cached').length, 0);
});

test('resume：agent 定义的 systemPrompt 变化会让缓存失效', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'resume-agentdef-'));
  const codexBin = await makeCodexShim(dir);
  const transcriptRoot = path.join(dir, 'runs');
  const agentDir = path.join(dir, 'myagents');
  await fsp.mkdir(agentDir, { recursive: true });
  const agentFile = path.join(agentDir, 'tuned.md');
  const script = `export const meta = {
  name: 'resume-agentdef',
  description: 'agent 定义影响提示词',
}
return await agent('干活', { agentType: 'tuned' })
`;

  await fsp.writeFile(agentFile, '---\nname: tuned\ndescription: d\n---\n\n原始人设。');
  const first = await runWorkflow({
    script, cwd: dir, codexBin, agentDirs: [agentDir], transcriptRoot,
  });

  // 只改 agent 定义正文，脚本一字未动
  await fsp.writeFile(agentFile, '---\nname: tuned\ndescription: d\n---\n\n换了个完全不同的人设。');
  const second = await runWorkflow({
    script, cwd: dir, codexBin, agentDirs: [agentDir], transcriptRoot,
    resumeFromRunId: first.runId,
  });

  assert.equal(second.agentCount, 1, 'agent 人设变了就不该复用旧结果');
});

test('非法 concurrency / budget 直接报错，不会挂起或静默失效', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'badnum-'));
  const script = "export const meta = {\n  name: 'n',\n  description: 'd',\n}\nreturn 1\n";
  const base = { script, cwd: dir, codexBin: '/nonexistent', transcriptRoot: path.join(dir, 'runs') };

  await assert.rejects(() => runWorkflow({ ...base, concurrency: NaN }), /concurrency 必须是/);
  await assert.rejects(() => runWorkflow({ ...base, concurrency: 0 }), /concurrency 必须是/);
  await assert.rejects(() => runWorkflow({ ...base, budget: NaN }), /budget 必须是/);
  await assert.rejects(() => runWorkflow({ ...base, budget: -1 }), /budget 必须是/);
});

test('workflow() 内联执行子 workflow 并共享计数', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'nested-'));
  const codexBin = await makeCodexShim(dir);
  const wfDir = path.join(dir, 'workflows');
  await fsp.mkdir(wfDir, { recursive: true });
  await fsp.writeFile(
    path.join(wfDir, 'child.js'),
    `export const meta = {
  name: 'child',
  description: '子流程',
}
return await agent('子任务:' + args.topic)
`,
  );

  const summary = await runWorkflow({
    script: `export const meta = {
  name: 'parent',
  description: '父流程',
}
const childResult = await workflow('child', { topic: 'X' })
const own = await agent('父任务')
return { childResult, own }
`,
    cwd: dir,
    codexBin,
    workflowDirs: [wfDir],
    transcriptRoot: path.join(dir, 'runs'),
  });

  assert.equal(summary.result.childResult, 'echo:子任务:X');
  assert.equal(summary.result.own, 'echo:父任务');
  assert.equal(summary.agentCount, 2, '子 workflow 的 agent 应计入总数');
});

test('子 workflow 内再调 workflow() 被拒绝', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'nested2-'));
  const codexBin = await makeCodexShim(dir);
  const wfDir = path.join(dir, 'workflows');
  await fsp.mkdir(wfDir, { recursive: true });
  await fsp.writeFile(
    path.join(wfDir, 'grandchild.js'),
    "export const meta = {\n  name: 'grandchild',\n  description: '孙',\n}\nreturn 1\n",
  );
  await fsp.writeFile(
    path.join(wfDir, 'child2.js'),
    "export const meta = {\n  name: 'child2',\n  description: '子',\n}\nreturn await workflow('grandchild')\n",
  );

  await assert.rejects(
    () =>
      runWorkflow({
        script: "export const meta = {\n  name: 'p2',\n  description: '父',\n}\nreturn await workflow('child2')\n",
        cwd: dir,
        codexBin,
        workflowDirs: [wfDir],
        transcriptRoot: path.join(dir, 'runs'),
      }),
    /层嵌套/,
  );
});

test('parallel 超过条目上限时报错而非静默截断', async () => {
  await assert.rejects(
    () =>
      run(`export const meta = {
  name: 'too-many',
  description: '超限',
}
return await parallel(Array.from({ length: 5000 }, () => () => Promise.resolve(1)))
`),
    /最多接受 4096/,
  );
});

test('summary.json 落盘且内容完整', async () => {
  const { summary } = await run(`export const meta = {
  name: 'summary',
  description: '产物',
}
return await agent('任务')
`);
  const saved = JSON.parse(
    await fsp.readFile(path.join(summary.transcriptDir, 'summary.json'), 'utf8'),
  );
  assert.equal(saved.runId, summary.runId);
  assert.equal(saved.status, 'ok');
  assert.ok(saved.usage.outputTokens > 0);
  // 脚本原文应被存档，供 resume 使用
  const archived = await fsp.readFile(path.join(summary.transcriptDir, 'workflow.js'), 'utf8');
  assert.match(archived, /name: 'summary'/);
});

test('连续恢复保留缓存，dry-run 不污染真实结果', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'resume-chain-'));
  const codexBin = await makeCodexShim(dir);
  const base = { script: 'export const meta = {name:"chain",description:"test"}; return await agent("task");', cwd: dir, codexBin };
  const first = await runWorkflow(base);
  const second = await runWorkflow({ ...base, resumeFromRunId: first.runId });
  const third = await runWorkflow({ ...base, resumeFromRunId: second.runId });
  assert.deepEqual([first.agentCount, second.agentCount, third.agentCount], [1, 0, 0]);
  const dry = await runWorkflow({ ...base, dryRun: true });
  const real = await runWorkflow({ ...base, resumeFromRunId: dry.runId });
  assert.equal(real.agentCount, 1);
  assert.equal(real.result, 'echo:task');
});

test('并发请求超额不能返回 ok，尚未派发的请求停止', async () => {
  const { summary } = await run('export const meta = {name:"overshoot",description:"test"}; return await parallel(Array.from({length:6},()=>()=>agent("task")));', {
    concurrency: 2, fakeEnv: { CDW_FAKE_DELAY_MS: 100 }, runOptions: { budget: 1 },
  });
  assert.equal(summary.status, 'budget_exhausted');
  assert.ok(summary.agentCount <= 2);
  assert.ok(summary.usage.outputTokens >= 50);
});

test('宿主对象、钩子、错误和返回值不能泄露宿主 Function', async () => {
  const { summary } = await run(`export const meta = {name:'escape-check',description:'test'};
    const attacks = [
      () => process,
      () => agent.constructor('return process')(),
      () => args.constructor.constructor('return process')(),
      () => budget.spent.constructor('return process')(),
      () => globalThis.Math.random(),
      () => globalThis.Date.now(),
      () => new (Object.getPrototypeOf(Date))(),
    ];
    const blocked = [];
    for (const attack of attacks) { try { attack(); blocked.push(false); } catch { blocked.push(true); } }
    const result = await agent('data', {schema:{type:'object',properties:{title:{type:'string'}}}});
    try { result.constructor.constructor('return process')(); blocked.push(false); } catch { blocked.push(true); }
    try { await agent('x',{agentType:'missing'}); } catch(e) {
      try { e.constructor.constructor('return process')(); blocked.push(false); } catch { blocked.push(true); }
    }
    return blocked;
  `, { runOptions: { args: {} } });
  assert.equal(summary.result.length, 9);
  assert.ok(summary.result.every(Boolean));
});

test('不存在的 codex 二进制立即失败并清理超时句柄', async () => {
  const { summary } = await run('export const meta={name:"missing-bin",description:"test"};return await parallel([()=>agent("task")]);', {
    runOptions: { codexBin: '/nonexistent/cdw-test-codex', maxRetries: 0 },
  });
  assert.deepEqual(summary.result, [null]);
});

test('Claude standalone agent terminal failure returns null and pipeline skips downstream', async () => {
  const {summary,events}=await run(`export const meta={name:'failure-null',description:'compat'};
    const first=await agent('task',undefined);
    const rows=await pipeline([1],()=>agent('task'),()=>{throw new Error('must not run')});
    return {first,rows};`,{fakeEnv:{CDW_FAKE_MODE:'crash'}});
  assert.deepEqual(summary.result,{first:null,rows:[null]});
  assert.equal(events.filter(e=>e.type==='agent.failed').length,2);
  assert.equal(events.filter(e=>e.type==='item.dropped').length,0);
});

test('Claude optional schema fields can be omitted by a real subprocess response',async()=>{
  const {summary}=await run(`export const meta={name:'optional',description:'compat'};
    return await agent('task',{schema:{type:'object',properties:{value:{type:'number'},note:{type:'string'}},required:['value'],additionalProperties:false}});`,
    {fakeEnv:{CDW_FAKE_RESPONSE:'{"value":7}'}});
  assert.deepEqual(summary.result,{value:7});
});

test('Claude schema failures get five corrections then null; process retries stay separate',async()=>{
 const {summary,dir}=await run(`export const meta={name:'invalid-schema-output',description:'compat'};
 return await agent('task',{schema:{type:'object',properties:{value:{type:'number'}},required:['value']}});`,
 {fakeEnv:{CDW_FAKE_RESPONSE:'{"value":"bad"}'},runOptions:{maxRetries:1}});
 assert.equal(summary.result,null);
 const lines=(await fsp.readFile(summary.journalFile,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(lines.find(x=>x.kind==='agent'&&x.status==='failed').attempts,6);
 const failed=await run(`export const meta={name:'process-failure',description:'compat'};return await agent('task',{schema:{type:'object'}});`,
 {fakeEnv:{CDW_FAKE_MODE:'crash'},runOptions:{maxRetries:1}});
 const records=(await fsp.readFile(failed.summary.journalFile,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(records.find(x=>x.kind==='agent'&&x.status==='failed').attempts,2);
});

test('budget blocks queued branches while preserving completed and in-flight results',async()=>{
 const {summary}=await run(`export const meta={name:'budget-branches',description:'compat'};
 return await parallel([()=>agent('one'),()=>agent('two'),()=>agent('three')]);`,
 {concurrency:2,runOptions:{budget:50},fakeEnv:{CDW_FAKE_DELAY_MS:50}});
 assert.equal(summary.status,'budget_exhausted');assert.equal(summary.agentCount,2);
 assert.deepEqual(summary.result,['echo:one','echo:two',null]);
});

test('built-in design-panel does not turn failed null proposals into successful objects',async()=>{
 await assert.rejects(()=>runWorkflow({
   cwd:workDir,workflowName:'design-panel',args:{question:'test',angles:[{key:'one',prompt:'test'}]},
   codexBin:'/definitely/missing/codex',maxRetries:0,transcriptRoot:path.join(workDir,'panel-failure'),
 }),/所有方案 agent 都失败/);
});

test('built-in migrate cannot report zero migration sites when discovery fails',async()=>{
 await assert.rejects(()=>runWorkflow({
   cwd:workDir,workflowName:'migrate',args:{instruction:'test'},
   codexBin:'/definitely/missing/codex',maxRetries:0,transcriptRoot:path.join(workDir,'migrate-failure'),
 }),/发现改造点的 agent 失败/);
});
