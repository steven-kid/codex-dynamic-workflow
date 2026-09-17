/**
 * Agent 类型注册表。
 *
 * 对标 Claude Code 的 `.claude/agents/*.md`：每个 agent 是一个带 YAML frontmatter 的
 * Markdown 文件，frontmatter 定义 model / effort / sandbox 默认值；Claude 工具权限配置需适配，
 * 正文是该 agent 的 system prompt 追加内容。
 *
 * 查找顺序（后者覆盖前者同名项）：
 *   1. 插件内置 agents/
 *   2. ~/.claude/agents/ → $CODEX_HOME/agents/
 *   3. <项目根>/.claude/agents/ → .codex/agents/  与  <项目根>/.agents/agents/
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { EFFORT_LEVELS, SANDBOX_MODES } from './constants.js';

import { parseYaml } from '../vendor/validation.js';

export function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: source.trim() };
  const data = parseYaml(match[1]) ?? {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('agent frontmatter 必须为对象');
  return { data, body: match[2].trim() };
}

/** 内置的 general-purpose agent：没有任何自定义时的兜底 */
export const DEFAULT_AGENT = Object.freeze({
  name: 'general-purpose',
  description: '通用子 agent，适用于未指定 agentType 的场景',
  model: null,
  effort: null,
  sandbox: null,
  systemPrompt: '',
  source: '<builtin>',
});

export async function loadAgentRegistry(dirs) {
  const registry = new Map([[DEFAULT_AGENT.name, DEFAULT_AGENT]]);

  for (const dir of dirs) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(dir, entry.name);
      try {
        const agent = await loadAgentFile(file);
        registry.set(agent.name, agent);
      } catch {
        // 单个 agent 文件损坏不应阻断整个 run
      }
    }
  }
  return registry;
}

export async function loadAgentFile(file) {
  const source = await fsp.readFile(file, 'utf8');
  const { data, body } = parseFrontmatter(source);
  const name = data.name || path.basename(file, '.md');

  return {
    name,
    description: data.description ?? '',
    model: data.model ?? null,
    effort: EFFORT_LEVELS.includes(data.effort) ? data.effort : null,
    sandbox: SANDBOX_MODES.includes(data.sandbox) ? data.sandbox : null,
    systemPrompt: body,
    source: file,
    unsupported: ['tools', 'disallowedTools', 'permissionMode', 'hooks', 'mcpServers', 'skills', 'memory', 'background', 'maxTurns', 'isolation'].filter(key => data[key] !== undefined),
  };
}
