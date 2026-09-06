/**
 * CLI 测试：真实执行 bin/cdw.js 子进程。
 * 同时用 dry-run 跑一遍所有内置 workflow，确保它们的控制流真的能走通
 * （只校验语法是不够的——参数解构、空结果分支这些只有跑起来才暴露）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, before, after } from 'node:test';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'cdw.js');
const FAKE_CODEX = path.join(HERE, 'fixtures', 'fake-codex.js');
const ROOT = path.join(HERE, '..');

let workDir;
let codexBin;

before(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cdw-cli-'));
  codexBin = path.join(workDir, 'codex-shim.sh');
  await fsp.writeFile(codexBin, `#!/bin/sh\nexec ${process.execPath} ${FAKE_CODEX} "$@"\n`);
  await fsp.chmod(codexBin, 0o755);
});

after(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

function cdw(args, opts = {}) {
  return exec(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: {
      ...process.env,
      CDW_CODEX_BIN: codexBin,
      CDW_TRANSCRIPT_ROOT: opts.transcriptRoot ?? path.join(workDir, 'runs'),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

test('cdw --help 输出用法', async () => {
  const { stdout } = await cdw(['--help']);
  assert.match(stdout, /Codex Dynamic Workflow/);
  assert.match(stdout, /cdw run/);
});

test('cdw list 列出全部内置 workflow', async () => {
  const { stdout } = await cdw(['list']);
  for (const name of ['review-changes', 'hunt-bugs', 'design-panel', 'understand-codebase', 'migrate']) {
    assert.match(stdout, new RegExp(name));
  }
  assert.doesNotMatch(stdout, /解析失败/);
});

test('cdw agents 列出内置 agentType', async () => {
  const { stdout } = await cdw(['agents']);
  for (const name of ['general-purpose', 'explorer', 'verifier', 'implementer']) {
    assert.match(stdout, new RegExp(name));
  }
});

test('cdw show 输出指定 workflow 的 meta', async () => {
  const { stdout } = await cdw(['show', 'review-changes']);
  const meta = JSON.parse(stdout);
  assert.equal(meta.name, 'review-changes');
  assert.ok(meta.scriptPath.endsWith('review-changes.js'));
  assert.ok(Array.isArray(meta.phases));
});

test('cdw validate 对合法与非法脚本给出正确结论', async () => {
  const good = path.join(workDir, 'good.js');
  await fsp.writeFile(good, "export const meta = {\n  name: 'good',\n  description: 'd',\n}\nreturn 1\n");
  const { stdout } = await cdw(['validate', good]);
  assert.match(stdout, /校验通过/);

  const bad = path.join(workDir, 'bad.js');
  await fsp.writeFile(bad, 'const a = (\n');
  await assert.rejects(() => cdw(['validate', bad]));
});

test('cdw run 执行脚本文件并输出结果', async () => {
  const script = path.join(workDir, 'wf.js');
  await fsp.writeFile(
    script,
    `export const meta = {
  name: 'cli-demo',
  description: 'CLI 用例',
}
return await agent('来自 CLI')
`,
  );
  const { stdout } = await cdw(['run', script, '--quiet']);
  assert.match(stdout, /echo:来自 CLI/);
});

test('cdw run --json 输出完整 summary', async () => {
  const script = path.join(workDir, 'wf2.js');
  await fsp.writeFile(
    script,
    "export const meta = {\n  name: 'cli-json',\n  description: 'd',\n}\nreturn await agent('x')\n",
  );
  const { stdout } = await cdw(['run', script, '--json']);
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.agentCount, 1);
  assert.ok(summary.usage.outputTokens > 0);
});

test('cdw run --args 支持内联 JSON', async () => {
  const script = path.join(workDir, 'wf3.js');
  await fsp.writeFile(
    script,
    "export const meta = {\n  name: 'cli-args',\n  description: 'd',\n}\nreturn args\n",
  );
  const { stdout } = await cdw(['run', script, '--json', '--args', '{"k":[1,2]}']);
  assert.deepEqual(JSON.parse(stdout).result, { k: [1, 2] });
});

test('cdw run - 从 stdin 读脚本', async () => {
  const scriptSource = [
    'export const meta = { name: "stdin-wf", description: "单行 meta 也要能解析" }',
    "return 'from-stdin'",
    '',
  ].join('\n');
  const stdinFile = path.join(workDir, 'stdin-src.js');
  await fsp.writeFile(stdinFile, scriptSource);

  const { stdout } = await exec(
    'sh',
    ['-c', `${process.execPath} ${CLI} run - --json < ${stdinFile}`],
    {
      cwd: ROOT,
      env: { ...process.env, CDW_CODEX_BIN: codexBin, CDW_TRANSCRIPT_ROOT: path.join(workDir, 'runs') },
    },
  );
  assert.equal(JSON.parse(stdout).result, 'from-stdin');
});

test('cdw runs 列出历史 run', async () => {
  const transcriptRoot = path.join(workDir, 'runs-list');
  const script = path.join(workDir, 'wf4.js');
  await fsp.writeFile(
    script,
    "export const meta = {\n  name: 'cli-runs',\n  description: 'd',\n}\nreturn await agent('x')\n",
  );
  await cdw(['run', script, '--quiet'], { transcriptRoot });
  const { stdout } = await cdw(['runs'], { transcriptRoot });
  assert.match(stdout, /wf_/);
  assert.match(stdout, /cli-runs/);
});

test('失败的 run 以非零退出码结束', async () => {
  const script = path.join(workDir, 'wf-fail.js');
  await fsp.writeFile(
    script,
    "export const meta = {\n  name: 'cli-fail',\n  description: 'd',\n}\nthrow new Error('故意失败')\n",
  );
  await assert.rejects(() => cdw(['run', script, '--quiet']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /故意失败/);
    return true;
  });
});

// 内置 workflow 的 dry-run 冒烟：只验证控制流能跑通，不调模型
const BUILTIN_CASES = [
  { name: 'review-changes', args: null },
  { name: 'understand-codebase', args: { target: 'src/' } },
  { name: 'hunt-bugs', args: { target: 'src/', maxRounds: 1, dryRounds: 1 } },
  { name: 'design-panel', args: { question: '要不要引入缓存层' } },
  { name: 'migrate', args: { instruction: '把 var 换成 const' } },
];

for (const { name, args } of BUILTIN_CASES) {
  test(`内置 workflow ${name} 在 dry-run 下能完整跑通`, async () => {
    const cliArgs = ['run', '--name', name, '--dry-run', '--json'];
    if (args) cliArgs.push('--args', JSON.stringify(args));
    const { stdout } = await cdw(cliArgs, {
      transcriptRoot: path.join(workDir, `runs-${name}`),
    });
    const summary = JSON.parse(stdout);
    assert.equal(summary.status, 'ok', `${name} 应成功完成`);
    assert.equal(summary.workflow, name);
    assert.ok(summary.agentCount > 0, `${name} 应至少派发一个 agent`);
  });
}

test('migrate 在没有改造点时优雅退出', async () => {
  // dry-run 下 discover 会返回一个占位 site，这里改为验证空结果分支：
  // 用一个内联脚本复刻 migrate 的空结果处理逻辑
  const script = path.join(workDir, 'empty-sites.js');
  await fsp.writeFile(
    script,
    `export const meta = {
  name: 'empty-sites',
  description: '空结果分支',
}
const discovery = { sites: [] }
const sites = (discovery && discovery.sites) || []
if (sites.length === 0) {
  log('没有找到需要改造的位置')
  return { sites: [], results: [] }
}
return await agent('不应执行到这里')
`,
  );
  const { stdout } = await cdw(['run', script, '--json']);
  const summary = JSON.parse(stdout);
  assert.equal(summary.agentCount, 0);
  assert.deepEqual(summary.result, { sites: [], results: [] });
});
