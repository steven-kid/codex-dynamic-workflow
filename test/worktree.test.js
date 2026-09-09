/**
 * worktree 隔离的回归测试。
 *
 * 这两条对应两个真实缺陷：
 *  1. agent 把改动 commit 之后，worktree 被误判为「无改动」而强制删除，成果永久丢失；
 *  2. 多阶段流程（改造 → 验证）里后一阶段回到主工作区，读到的是未修改的旧文件。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, before, after } from 'node:test';

import { runWorkflow } from '../src/engine/runner.js';
import { createWorktree } from '../src/engine/worktree.js';

const exec = promisify(execFile);
let workDir;

before(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cdw-wt-'));
});

after(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function makeRepo(name) {
  const dir = path.join(workDir, name);
  await fsp.mkdir(dir, { recursive: true });
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await fsp.writeFile(path.join(dir, 'f.txt'), 'base\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-qm', 'init'], dir);
  return dir;
}

/** 让桩 agent 在 --cd 指定目录里干活；action 决定它写文件还是提交 */
async function makeShim(dir, action) {
  const shim = path.join(dir, `shim-${action}.sh`);
  const body = {
    // 只改工作区，不提交
    dirty: 'echo "changed" >> "$CD/f.txt"',
    // 改完就提交——这是触发误删缺陷的关键路径
    commit:
      'echo "changed" >> "$CD/f.txt" && git -C "$CD" add -A && git -C "$CD" commit -qm "agent work"',
    // 什么也不改
    noop: 'true',
    // 追加一行并读回文件全文，用于验证后一阶段看到的是哪份文件
    append: 'echo "STAGE" >> "$CD/f.txt"',
  }[action];

  await fsp.writeFile(
    shim,
    `#!/bin/sh
CD=""
while [ $# -gt 0 ]; do case "$1" in --cd) CD="$2"; shift 2;; *) shift;; esac; done
cat > /dev/null
${body}
CONTENT=$(tr '\\n' ',' < "$CD/f.txt")
echo '{"type":"thread.started","thread_id":"t1"}'
printf '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"%s"}}\\n' "$CONTENT"
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
`,
  );
  await fsp.chmod(shim, 0o755);
  return shim;
}

test('agent 提交了改动时 worktree 必须保留（不能误判为空并删除）', async () => {
  const repo = await makeRepo('committed');
  const codexBin = await makeShim(repo, 'commit');

  const summary = await runWorkflow({
    script: `export const meta = {
  name: 'wt-commit',
  description: '提交后不应被删',
}
return await agent('改并提交', { isolation: 'worktree', label: 'w' })
`,
    cwd: repo,
    codexBin,
    transcriptRoot: path.join(repo, 'runs'),
  });

  assert.equal(summary.status, 'ok');
  assert.equal(summary.worktrees.length, 1, 'agent 已提交改动，worktree 必须被保留');

  const kept = summary.worktrees[0];
  // 目录与分支都还在，成果没丢
  await fsp.access(kept.path);
  const content = await fsp.readFile(path.join(kept.path, 'f.txt'), 'utf8');
  assert.match(content, /changed/);
  const branches = await git(['branch', '--list', kept.branch], repo);
  assert.ok(branches.includes(kept.branch), '分支不应被删除');
});

test('agent 只改工作区未提交时 worktree 同样保留', async () => {
  const repo = await makeRepo('dirty');
  const codexBin = await makeShim(repo, 'dirty');

  const summary = await runWorkflow({
    script: "export const meta = {\n  name: 'wt-dirty',\n  description: 'd',\n}\nreturn await agent('改不提交', { isolation: 'worktree' })\n",
    cwd: repo,
    codexBin,
    transcriptRoot: path.join(repo, 'runs'),
  });
  assert.equal(summary.worktrees.length, 1);
});

test('agent 无任何改动时 worktree 被自动清理', async () => {
  const repo = await makeRepo('clean');
  const codexBin = await makeShim(repo, 'noop');

  const before = (await git(['worktree', 'list'], repo)).split('\n').length;
  const summary = await runWorkflow({
    script: "export const meta = {\n  name: 'wt-clean',\n  description: 'd',\n}\nreturn await agent('什么也不改', { isolation: 'worktree' })\n",
    cwd: repo,
    codexBin,
    transcriptRoot: path.join(repo, 'runs'),
  });

  assert.equal(summary.worktrees.length, 0, '无改动应被清理');
  const after = (await git(['worktree', 'list'], repo)).split('\n').length;
  assert.equal(after, before, 'worktree 数量应回到原值');
});

test('同一 worktreeKey 的多阶段 agent 共用同一份 worktree', async () => {
  const repo = await makeRepo('shared');
  const codexBin = await makeShim(repo, 'append');

  const summary = await runWorkflow({
    script: `export const meta = {
  name: 'wt-shared',
  description: '改造与验证同处一个 worktree',
}
const first = await agent('第一阶段', {
  isolation: 'worktree', worktreeKey: 'site-0', label: 'transform',
})
const second = await agent('第二阶段', {
  isolation: 'worktree', worktreeKey: 'site-0', label: 'verify',
})
return { first, second }
`,
    cwd: repo,
    codexBin,
    transcriptRoot: path.join(repo, 'runs'),
  });

  assert.equal(summary.status, 'ok');
  // 桩把 f.txt 全文回读出来：第二阶段必须看到第一阶段追加的那行
  assert.equal(summary.result.first, 'base,STAGE,');
  assert.equal(
    summary.result.second,
    'base,STAGE,STAGE,',
    '第二阶段应看到第一阶段的改动，说明它跑在同一个 worktree 里',
  );
  assert.equal(summary.worktrees.length, 1, '两个 agent 只应创建一份 worktree');

  // 主工作区不受污染
  const mainContent = await fsp.readFile(path.join(repo, 'f.txt'), 'utf8');
  assert.equal(mainContent, 'base\n');
});

test('不同 worktreeKey 的 agent 互相隔离', async () => {
  const repo = await makeRepo('isolated');
  const codexBin = await makeShim(repo, 'append');

  const summary = await runWorkflow({
    script: `export const meta = {
  name: 'wt-isolated',
  description: '不同 key 互不可见',
}
return await parallel([
  () => agent('甲', { isolation: 'worktree', worktreeKey: 'site-a' }),
  () => agent('乙', { isolation: 'worktree', worktreeKey: 'site-b' }),
])
`,
    cwd: repo,
    codexBin,
    transcriptRoot: path.join(repo, 'runs'),
  });

  // 两者都只看到自己追加的那一行，说明彼此隔离
  assert.deepEqual(summary.result, ['base,STAGE,', 'base,STAGE,']);
  assert.equal(summary.worktrees.length, 2);
});

test('createWorktree 记录基准 commit 供 finalize 判断', async () => {
  const repo = await makeRepo('base-commit');
  const head = await git(['rev-parse', 'HEAD'], repo);
  const wt = await createWorktree({ repoRoot: repo, name: 'probe' });
  try {
    assert.equal(wt.baseCommit, head);
  } finally {
    await wt.remove();
  }
});
