#!/usr/bin/env node
/**
 * 测试桩：模拟 `codex exec --json` 的行为。
 *
 * 本机 codex 未登录，无法真实调用模型，因此用这个桩做端到端验证：
 * 它解析真实的 codex 参数（--output-schema / --output-last-message / --cd / -c ...），
 * 从 stdin 读 prompt，按 CDW_FAKE_MODE 决定行为，并输出与真实 codex 一致的
 * thread events JSONL。
 *
 * 通过 CDW_CODEX_BIN 指向本文件即可让引擎跑在桩上。
 */

import fs from 'node:fs';

const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

const schemaPath = flagValue('--output-schema');
const lastMessagePath = flagValue('--output-last-message');
const mode = process.env.CDW_FAKE_MODE || 'ok';
const delayMs = Number(process.env.CDW_FAKE_DELAY_MS || 0);

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  emit({ type: 'thread.started', thread_id: `th_${process.pid}` });
  emit({ type: 'turn.started' });

  if (mode === 'crash') {
    emit({ type: 'error', message: '模拟的执行失败' });
    emit({ type: 'turn.failed', error: { message: '模拟的执行失败' } });
    process.exit(3);
  }

  // 真实 codex 会在中间穿插若干 item，这里也发一条，用于验证解析器不会误取中间消息
  emit({
    type: 'item.completed',
    item: { id: 'item_0', type: 'reasoning', text: '思考中' },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: 'a.js',
      exit_code: 0,
      status: 'completed',
    },
  });

  let finalText;
  if (schemaPath) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    // badschema 模式：第一次返回不合规内容，制造一次 schema 重试
    const isCorrection = prompt.includes('上一次输出不合规');
    finalText =
      mode === 'badschema' && !isCorrection
        ? '这不是 JSON'
        : JSON.stringify(sample(schema, prompt));
    // 模拟 codex#19816：中间消息也被 schema 约束，引擎必须取最后一条
    emit({
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: JSON.stringify(sample(schema, 'INTERMEDIATE')) },
    });
  } else {
    finalText = `echo:${firstLineOfTask(prompt)}`;
  }

  emit({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: finalText } });
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 5,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    },
  });

  if (lastMessagePath) fs.writeFileSync(lastMessagePath, finalText, 'utf8');
  process.exit(0);
});

/** 按 schema 造一份合法样例，字符串里带上任务首行便于断言 */
function sample(schema, prompt) {
  const marker = firstLineOfTask(prompt);
  const build = (node) => {
    const type = [].concat(node.type ?? 'object')[0];
    switch (type) {
      case 'object': {
        const out = {};
        for (const [key, sub] of Object.entries(node.properties ?? {})) out[key] = build(sub);
        return out;
      }
      case 'array':
        return node.items ? [build(node.items)] : [];
      case 'string':
        return node.enum ? node.enum[0] : marker;
      case 'number':
      case 'integer':
        return 42;
      case 'boolean':
        return true;
      default:
        return null;
    }
  };
  return build(schema);
}

/** 从组装后的 prompt 里取出「# 任务」段的首行，用于断言 prompt 正确传达 */
function firstLineOfTask(prompt) {
  const idx = prompt.indexOf('# 任务');
  const body = idx === -1 ? prompt : prompt.slice(idx + 4);
  return body.trim().split('\n')[0].trim().slice(0, 80) || 'empty';
}
