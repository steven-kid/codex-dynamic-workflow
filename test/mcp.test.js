/**
 * MCP server 测试：真实以子进程方式拉起 `cdw mcp`，走 JSON-RPC 握手与工具调用。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';

import { describeEvent } from '../src/mcp/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'cdw.js');
const FAKE_CODEX = path.join(HERE, 'fixtures', 'fake-codex.js');

let workDir;
let codexBin;

before(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cdw-mcp-'));
  codexBin = path.join(workDir, 'codex-shim.sh');
  await fsp.writeFile(codexBin, `#!/bin/sh\nexec ${process.execPath} ${FAKE_CODEX} "$@"\n`);
  await fsp.chmod(codexBin, 0o755);
});

after(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

/** 起一个 MCP server 子进程，按行收发 JSON-RPC */
function startServer(cwd) {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    cwd,
    env: { ...process.env, CDW_CODEX_BIN: codexBin, CDW_TRANSCRIPT_ROOT: path.join(cwd, 'runs') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buffer = '';
  const notifications = [];

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        notifications.push(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`请求 ${method} 超时`)), 30000).unref?.();
    });

  return { child, request, notifications, stop: () => child.kill('SIGKILL') };
}

test('initialize 握手返回 serverInfo 与 capabilities', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'init-'));
  const server = startServer(dir);
  try {
    const res = await server.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(res.result.serverInfo.name, 'codex-dynamic-workflow');
    assert.ok(res.result.capabilities.tools);
  } finally {
    server.stop();
  }
});

test('tools/list 暴露全部五个工具且 schema 合法', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'list-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const res = await server.request('tools/list', {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'workflow_inspect',
      'workflow_list',
      'workflow_run',
      'workflow_runs',
      'workflow_validate',
    ]);
    for (const tool of res.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 10);
    }
    // 触发门槛必须写在 description 里，主 agent 才不会滥用
    const runTool = res.result.tools.find((t) => t.name === 'workflow_run');
    assert.match(runTool.description, /只有用户明确|仅在用户明确/);
  } finally {
    server.stop();
  }
});

test('tools/call 执行内联 workflow 并返回结构化结果', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'call-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const res = await server.request('tools/call', {
      name: 'workflow_run',
      arguments: {
        script: `export const meta = {
  name: 'mcp-demo',
  description: 'MCP 调用',
}
phase('Work')
return await parallel([() => agent('甲'), () => agent('乙')])
`,
        cwd: dir,
      },
    });

    assert.notEqual(res.result.isError, true);
    const payload = res.result.structuredContent;
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.result, ['echo:甲', 'echo:乙']);
    assert.equal(payload.agentCount, 2);
    assert.ok(payload.runId.startsWith('wf_'));
    assert.ok(payload.transcriptDir);
  } finally {
    server.stop();
  }
});

test('workflow_validate 只校验不执行', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'validate-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const ok = await server.request('tools/call', {
      name: 'workflow_validate',
      arguments: {
        script: "export const meta = {\n  name: 'v',\n  description: 'd',\n}\nreturn 1\n",
      },
    });
    assert.match(ok.result.content[0].text, /校验通过/);

    const bad = await server.request('tools/call', {
      name: 'workflow_validate',
      arguments: { script: 'const a = 1\n' },
    });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /meta/);
  } finally {
    server.stop();
  }
});

test('workflow_list 列出内置 workflow 与 agentType', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'wflist-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const res = await server.request('tools/call', { name: 'workflow_list', arguments: {} });
    const { workflows, agentTypes } = res.result.structuredContent;
    const names = workflows.map((w) => w.name);
    for (const expected of ['review-changes', 'hunt-bugs', 'design-panel', 'understand-codebase', 'migrate']) {
      assert.ok(names.includes(expected), `应包含内置 workflow ${expected}`);
    }
    // 内置 workflow 必须全部能被解析，不能有解析失败的
    for (const wf of workflows) assert.equal(wf.error, undefined, `${wf.name} 解析失败`);
    const agentNames = agentTypes.map((a) => a.name);
    for (const expected of ['general-purpose', 'explorer', 'verifier', 'implementer']) {
      assert.ok(agentNames.includes(expected), `应包含 agentType ${expected}`);
    }
  } finally {
    server.stop();
  }
});

test('workflow_runs 与 workflow_inspect 能回溯历史 run', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'inspect-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const run = await server.request('tools/call', {
      name: 'workflow_run',
      arguments: {
        script: "export const meta = {\n  name: 'insp',\n  description: 'd',\n}\nreturn await agent('检查我')\n",
        cwd: dir,
      },
    });
    const runId = run.result.structuredContent.runId;

    const runs = await server.request('tools/call', {
      name: 'workflow_runs',
      arguments: { cwd: dir },
    });
    assert.ok(runs.result.structuredContent.runs.some((r) => r.runId === runId));

    const inspect = await server.request('tools/call', {
      name: 'workflow_inspect',
      arguments: { runId, cwd: dir },
    });
    const entries = inspect.result.structuredContent.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result, 'echo:检查我');
    assert.equal(entries[0].status, 'ok');
  } finally {
    server.stop();
  }
});

test('未知工具返回 JSON-RPC 错误', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'unknown-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const res = await server.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(res.error.code, -32602);
  } finally {
    server.stop();
  }
});

test('工具内部异常以 isError 返回，不打断连接', async () => {
  const dir = await fsp.mkdtemp(path.join(workDir, 'err-'));
  const server = startServer(dir);
  try {
    await server.request('initialize', {});
    const res = await server.request('tools/call', {
      name: 'workflow_run',
      arguments: { name: '不存在的-workflow', cwd: dir },
    });
    assert.equal(res.result.isError, true);
    // 连接仍然可用
    const ping = await server.request('ping', {});
    assert.deepEqual(ping.result, {});
  } finally {
    server.stop();
  }
});

test('describeEvent 把引擎事件压成人话', () => {
  assert.match(describeEvent({ type: 'phase.started', title: 'Review' }), /Review/);
  assert.match(describeEvent({ type: 'agent.completed', label: 'x', durationMs: 5 }), /✔ x/);
  assert.equal(describeEvent({ type: 'unknown' }), null);
});
