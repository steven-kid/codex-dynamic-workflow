import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeSchema, assertRootSchema, extractJson, validateAgainstSchema } from '../src/engine/schema.js';
import { parseMeta, compileScript } from '../src/engine/script.js';
import { parseEventLine, normalizeUsage, buildCodexArgs, addUsage, emptyUsage } from '../src/engine/codex.js';
import { parseFrontmatter } from '../src/engine/agents.js';
import { buildAgentPrompt } from '../src/engine/prompt.js';
import { Semaphore } from '../src/engine/semaphore.js';
import { fingerprint } from '../src/engine/journal.js';
import { parseArgs, parseNumericOption } from '../src/cli.js';

test('normalizeSchema 递归补齐 strict 模式要求的字段', () => {
  const out = normalizeSchema({
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' } } },
      },
    },
  });
  assert.equal(out.additionalProperties, false);
  assert.deepEqual(out.required, ['findings']);
  const item = out.properties.findings.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ['file', 'line']);
});

test('normalizeSchema 处理 $defs 与 anyOf 分支', () => {
  const out = normalizeSchema({
    type: 'object',
    properties: { node: { $ref: '#/$defs/Node' } },
    $defs: {
      Node: { type: 'object', properties: { name: { type: 'string' } } },
    },
  });
  assert.equal(out.$defs.Node.additionalProperties, false);
  assert.deepEqual(out.$defs.Node.required, ['name']);
});

test('assertRootSchema 拒绝非 object 根', () => {
  assert.throws(() => assertRootSchema({ type: 'array', items: { type: 'string' } }), /必须是/);
});

test('extractJson 能剥掉代码围栏和前后寒暄', () => {
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```').value, { a: 2 });
  assert.deepEqual(extractJson('结果如下：\n{"a":3}\n希望有帮助').value, { a: 3 });
  assert.equal(extractJson('完全不是 JSON').ok, false);
  assert.equal(extractJson('').ok, false);
});

test('validateAgainstSchema 捕获缺失字段与类型错误', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, count: { type: 'number' } },
    required: ['name', 'count'],
  };
  assert.equal(validateAgainstSchema({ name: 'a', count: 1 }, schema).valid, true);
  const missing = validateAgainstSchema({ name: 'a' }, schema);
  assert.equal(missing.valid, false);
  assert.match(missing.errors[0], /count/);
  const wrongType = validateAgainstSchema({ name: 'a', count: 'x' }, schema);
  assert.equal(wrongType.valid, false);
});

test('validateAgainstSchema 支持 enum 与嵌套数组', () => {
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', properties: { level: { type: 'string', enum: ['a', 'b'] } } },
      },
    },
  };
  assert.equal(validateAgainstSchema({ items: [{ level: 'a' }] }, schema).valid, true);
  assert.equal(validateAgainstSchema({ items: [{ level: 'z' }] }, schema).valid, false);
});

test('parseMeta 读出纯字面量 meta', () => {
  const { meta } = parseMeta(`export const meta = {
  name: 'demo',
  description: '示例',
  phases: [{ title: 'A' }],
}
const x = 1
`);
  assert.equal(meta.name, 'demo');
  assert.equal(meta.phases.length, 1);
});

test('parseMeta 支持单行 meta 与嵌套对象', () => {
  const single = parseMeta('export const meta = { name: "one-line", description: "d" }\nreturn 1\n');
  assert.equal(single.meta.name, 'one-line');

  const nested = parseMeta(`export const meta = {
  name: 'nested',
  description: '嵌套',
  phases: [{ title: 'A', detail: 'x' }, { title: 'B' }],
}
return 2
`);
  assert.equal(nested.meta.phases.length, 2);
  assert.equal(nested.meta.phases[0].detail, 'x');
});

test('parseMeta 剥离 meta 后保留原始行号', () => {
  const source = `export const meta = {
  name: 'lines',
  description: 'd',
}
const marker = 1
`;
  const { body } = parseMeta(source);
  // meta 占了 4 行，body 里 marker 仍应在第 5 行
  assert.equal(body.split('\n')[4], 'const marker = 1');
});

test('parseMeta 不会被字符串里的花括号误导', () => {
  const { meta } = parseMeta(
    'export const meta = { name: "braces", description: "包含 } 和 { 的描述" }\nreturn 1\n',
  );
  assert.equal(meta.description, '包含 } 和 { 的描述');
});

test('parseMeta 拒绝非字面量 meta', () => {
  assert.throws(
    () => parseMeta("export const meta = {\n  name: makeName(),\n  description: 'x',\n}\n"),
    /纯字面量/,
  );
  assert.throws(
    () => parseMeta('export const meta = {\n  name: `demo`,\n  description: "x",\n}\n'),
    /纯字面量/,
  );
});

test('parseMeta 校验 name 必须 kebab-case', () => {
  assert.throws(
    () => parseMeta("export const meta = {\n  name: 'BadName',\n  description: 'x',\n}\n"),
    /kebab-case/,
  );
});

test('缺少 meta 的脚本被拒绝', () => {
  assert.throws(() => parseMeta('const a = 1\n'), /export const meta/);
});

test('compileScript 阻止 Date.now 与 Math.random', async () => {
  const { run } = compileScript(
    "export const meta = {\n  name: 'x',\n  description: 'd',\n}\nreturn Date.now()\n",
  );
  await assert.rejects(() => run(), /Date\.now/);

  const { run: run2 } = compileScript(
    "export const meta = {\n  name: 'x',\n  description: 'd',\n}\nreturn Math.random()\n",
  );
  await assert.rejects(() => run2(), /Math\.random/);
});

test('确定性守卫不能被 globalThis 绕过', async () => {
  // 只声明局部 Date/Math 只能遮蔽标识符，走 globalThis 就能绕开，
  // 所以脚本必须跑在独立 context 里、由 context 自身的 Date/Math 代理兜底
  const cases = [
    ['globalThis.Date.now()', /Date\.now/],
    ['globalThis.Math.random()', /Math\.random/],
    ['new globalThis.Date()', /new Date\(\)/],
    ["globalThis['Date']['now']()", /Date\.now/],
    ['(0, globalThis.Math.random)()', /Math\.random/],
  ];
  for (const [expr, pattern] of cases) {
    const { run } = compileScript(
      `export const meta = {\n  name: 'x',\n  description: 'd',\n}\nreturn ${expr}\n`,
    );
    await assert.rejects(() => run(), pattern, `${expr} 应被拦截`);
  }
});

test('脚本 context 不暴露 I/O 能力', async () => {
  // 编排脚本不该做 I/O——这些交给子 agent。
  // process 可见还意味着脚本能读到环境变量。
  const { run } = compileScript(`export const meta = {
  name: 'x',
  description: 'd',
}
return {
  fetch: typeof fetch,
  process: typeof process,
  require: typeof require,
  setTimeout: typeof setTimeout,
  XMLHttpRequest: typeof XMLHttpRequest,
}
`);
  // 脚本对象来自独立 realm，原型不同，逐字段断言而非 deepStrictEqual
  const caps = await run();
  for (const key of ['fetch', 'process', 'require', 'setTimeout', 'XMLHttpRequest']) {
    assert.equal(caps[key], 'undefined', `${key} 不应对脚本可见`);
  }
});

test('脚本仍可使用编排所需的语言内建能力', async () => {
  const { run } = compileScript(`export const meta = {
  name: 'x',
  description: 'd',
}
const parsed = JSON.parse('{"a":1}')
const joined = [3, 1, 2].sort().map(String).join('')
const awaited = await Promise.all([Promise.resolve('x')])
return { parsed: parsed.a, joined, awaited: awaited[0], now: new Date(0).getTime() }
`);
  const out = await run();
  assert.equal(out.parsed, 1);
  assert.equal(out.joined, '123');
  assert.equal(out.awaited, 'x');
  assert.equal(out.now, 0, '带参数的 new Date 仍应可用');
});

test('compileScript 允许带参数的 new Date', async () => {
  const { run } = compileScript(
    "export const meta = {\n  name: 'x',\n  description: 'd',\n}\nreturn new Date(0).getTime()\n",
  );
  assert.equal(await run(), 0);
});

test('parseEventLine 忽略 codex 的 tracing 日志行', () => {
  assert.equal(parseEventLine('2026-09-17T15:12:47Z ERROR something failed'), null);
  assert.equal(parseEventLine(''), null);
  assert.deepEqual(parseEventLine('{"type":"turn.started"}'), { type: 'turn.started' });
  assert.equal(parseEventLine('{"no_type":1}'), null);
});

test('normalizeUsage 补齐缺失字段', () => {
  const usage = normalizeUsage({ input_tokens: 10, output_tokens: 5 });
  assert.equal(usage.cacheWriteInputTokens, 0);
  assert.equal(usage.inputTokens, 10);
  assert.equal(addUsage(emptyUsage(), usage).outputTokens, 5);
});

test('buildCodexArgs 生成正确的 codex 参数', () => {
  const args = buildCodexArgs({
    cwd: '/work',
    model: 'o3',
    effort: 'high',
    sandbox: 'read-only',
    schemaPath: '/tmp/s.json',
    lastMessagePath: '/tmp/last.txt',
  });
  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.equal(args.at(-1), '-', 'prompt 必须从 stdin 传入');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});

test('parseFrontmatter 解析 agent 定义', () => {
  const { data, body } = parseFrontmatter(
    '---\nname: verifier\neffort: high\ntools: [Read, Grep]\n---\n\n正文内容',
  );
  assert.equal(data.name, 'verifier');
  assert.deepEqual(data.tools, ['Read', 'Grep']);
  assert.equal(body, '正文内容');
});

test('buildAgentPrompt 注入返回值契约与 schema', () => {
  const prompt = buildAgentPrompt({
    prompt: '找出 bug',
    schema: { type: 'object', properties: {} },
    agentSystemPrompt: '你是验证者',
    phase: 'Verify',
  });
  assert.match(prompt, /最终消息\*\*就是\*\*这次调用的返回值/);
  assert.match(prompt, /JSON Schema/);
  assert.match(prompt, /你是验证者/);
  assert.match(prompt, /当前阶段：Verify/);
  assert.match(prompt, /# 任务\n\n找出 bug/);
});

test('Semaphore 限制并发峰值', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(sem.active, 0);
});

test('Semaphore 在异常路径也释放槽位', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(() => sem.run(async () => { throw new Error('boom'); }));
  assert.equal(sem.active, 0);
  assert.equal(await sem.run(async () => 'ok'), 'ok');
});

test('fingerprint 对影响执行的输入敏感、对展示类字段不敏感', () => {
  const base = fingerprint('p', { model: 'a' });
  assert.equal(base, fingerprint('p', { model: 'a', label: '换个标签' }));
  assert.notEqual(base, fingerprint('p', { model: 'b' }));
  assert.notEqual(base, fingerprint('别的 prompt', { model: 'a' }));
});

test('fingerprint 覆盖 phase / systemPrompt / worktreeKey 等实际执行输入', () => {
  const base = fingerprint('p', { phase: 'A', model: 'm', agentSystemPrompt: 's' });
  // phase 会被写进提示词，改了必须让缓存失效
  assert.notEqual(base, fingerprint('p', { phase: 'B', model: 'm', agentSystemPrompt: 's' }));
  // agent 定义的 systemPrompt 同样进提示词
  assert.notEqual(base, fingerprint('p', { phase: 'A', model: 'm', agentSystemPrompt: '改了' }));
  // worktreeKey 决定 agent 实际运行目录
  assert.notEqual(
    fingerprint('p', { isolation: 'worktree', worktreeKey: 'k1' }),
    fingerprint('p', { isolation: 'worktree', worktreeKey: 'k2' }),
  );
  // 相同输入必须稳定
  assert.equal(base, fingerprint('p', { phase: 'A', model: 'm', agentSystemPrompt: 's' }));
});

test('Semaphore 拒绝 NaN 等非法并发上限', () => {
  // NaN 会让 `active < limit` 恒为 false，首个 acquire 永久挂起
  assert.throws(() => new Semaphore(NaN), /必须是 ≥1 的有限整数/);
  assert.throws(() => new Semaphore(0), /必须是 ≥1 的有限整数/);
  assert.throws(() => new Semaphore(Infinity), /必须是 ≥1 的有限整数/);
  assert.equal(new Semaphore(3).limit, 3);
});

test('parseNumericOption 拒绝非法数值、放行合法值', () => {
  assert.throws(() => parseNumericOption('abc', 'budget', { integer: true, min: 0 }), /有限数值/);
  assert.throws(() => parseNumericOption('1.5', 'concurrency', { integer: true, min: 1 }), /整数/);
  assert.throws(() => parseNumericOption('0', 'concurrency', { integer: true, min: 1 }), /不能小于 1/);
  assert.throws(() => parseNumericOption(true, 'budget', {}), /需要一个数值/);
  assert.equal(parseNumericOption('8', 'concurrency', { integer: true, min: 1 }), 8);
  assert.equal(parseNumericOption(undefined, 'budget', { fallback: null }), null);
  assert.equal(parseNumericOption('', 'budget', { fallback: null }), null);
  // 0 是合法预算，不能被 falsy 判断吞掉
  assert.equal(parseNumericOption('0', 'budget', { integer: true, min: 0 }), 0);
});

test('parseArgs 解析 CLI 参数', () => {
  const opts = parseArgs(['run', 'x.js', '--budget', '100', '--dry-run', '--args={"a":1}']);
  assert.deepEqual(opts._, ['run', 'x.js']);
  assert.equal(opts.budget, '100');
  assert.equal(opts['dry-run'], true);
  assert.equal(opts.args, '{"a":1}');
});

test('动态 import 在执行前被拒绝，避免宿主模块错误泄露', () => {
  for (const expression of ["import('node:fs')", "import /* comment */ ('node:fs')", "import // comment\n ('node:fs')"]) {
    assert.throws(() => compileScript(`export const meta={name:'imports',description:'test'}; return ${expression};`), /不支持 import/);
  }
});
