/**
 * Journal：把每一次 agent() 调用的输入指纹与返回值追加写入 journal.jsonl。
 *
 * resume 的语义（对齐 Claude Code Dynamic Workflow）：
 *   同一个 (调用序号, prompt+opts 指纹) 命中缓存 → 直接返回历史结果，不再跑模型；
 *   一旦某次调用的指纹变了，从它开始及其之后的所有调用全部重跑。
 * 所以缓存必须是「最长未变前缀」，而不是按 key 随机命中。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 对 agent 调用做稳定指纹。
 *
 * 必须覆盖**最终真正影响执行的输入**，而不是脚本里写的原始 opts：
 * phase 会被 buildAgentPrompt 写进提示词、model/effort/sandbox 存在多级默认值
 * （opts → agent 定义 → run 级默认）、agentType 的 systemPrompt 也会进提示词。
 * 任何一项漏掉，改了它之后 resume 仍会命中旧缓存，直接返回历史结果。
 * 所以调用方应传入**解析后**的配置（见 runner.js 的 resolveExecutionInputs）。
 */
export function fingerprint(prompt, resolved = {}) {
  const significant = {
    prompt,
    phase: resolved.phase ?? null,
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    sandbox: resolved.sandbox ?? null,
    schema: resolved.schema ?? null,
    agentType: resolved.agentType ?? null,
    agentSystemPrompt: resolved.agentSystemPrompt ?? null,
    isolation: resolved.isolation ?? null,
    worktreeKey: resolved.worktreeKey ?? null,
    cwd: resolved.cwd ?? null,
  };
  return createHash('sha256').update(JSON.stringify(significant)).digest('hex').slice(0, 32);
}

export class Journal {
  #dir;
  #file;
  #stream = null;
  /** resume 时载入的历史记录，按调用序号索引 */
  #priorEntries = new Map();
  /** 前缀是否仍然完好；一旦 miss 就永久置 false */
  #prefixIntact = true;

  constructor(dir) {
    this.#dir = dir;
    this.#file = path.join(dir, 'journal.jsonl');
  }

  get file() {
    return this.#file;
  }

  get dir() {
    return this.#dir;
  }

  async init() {
    await fsp.mkdir(this.#dir, { recursive: true });
    this.#stream = fs.createWriteStream(this.#file, { flags: 'a' });
  }

  /** 从上一次 run 的 journal 载入历史结果 */
  async loadPrior(priorDir) {
    const priorFile = path.join(priorDir, 'journal.jsonl');
    let raw;
    try {
      raw = await fsp.readFile(priorFile, 'utf8');
    } catch {
      return { loaded: 0 };
    }
    let loaded = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.kind === 'agent' && typeof entry.seq === 'number') {
          this.#priorEntries.set(entry.seq, entry);
          loaded += 1;
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
    return { loaded };
  }

  /**
   * 查询缓存。只有「前缀完好 + 序号命中 + 指纹一致 + 当时成功」才算命中。
   */
  lookup(seq, fp) {
    if (!this.#prefixIntact) return null;
    const prior = this.#priorEntries.get(seq);
    if (!prior || prior.fingerprint !== fp || prior.status !== 'ok') {
      this.#prefixIntact = false;
      return null;
    }
    return prior;
  }

  /** 显式作废后续缓存（例如脚本结构变了） */
  breakPrefix() {
    this.#prefixIntact = false;
  }

  get prefixIntact() {
    return this.#prefixIntact;
  }

  append(entry) {
    if (!this.#stream) return;
    this.#stream.write(`${JSON.stringify(entry)}\n`);
  }

  async close() {
    if (!this.#stream) return;
    await new Promise((resolve) => this.#stream.end(resolve));
    this.#stream = null;
  }
}
