/**
 * 路径解析：统一处理 CODEX_HOME、项目根、插件根的查找顺序。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeta } from '../engine/script.js';

/** 插件包根目录（src/util/../..） */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** 从 cwd 向上找 .git / .codex / package.json，找不到就用 cwd */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    for (const marker of ['.git', '.codex', '.agents', '.claude', 'package.json']) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    if (dir === root) return path.resolve(startDir);
    dir = path.dirname(dir);
  }
}

/**
 * workflow 脚本搜索路径，优先级从低到高（后面的覆盖前面的同名脚本）：
 *   插件内置 → ~/.claude → CODEX_HOME → 项目 .claude → .codex → .agents
 */
export function workflowDirs(cwd = process.cwd()) {
  const project = findProjectRoot(cwd);
  return [
    path.join(PLUGIN_ROOT, 'workflows'),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'workflows'),
    path.join(codexHome(), 'workflows'),
    path.join(project, '.claude', 'workflows'),
    path.join(project, '.codex', 'workflows'),
    path.join(project, '.agents', 'workflows'),
  ];
}

/** agent 定义搜索路径，顺序同上 */
export function agentDirs(cwd = process.cwd()) {
  const project = findProjectRoot(cwd);
  return [
    path.join(PLUGIN_ROOT, 'agents'),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'agents'),
    path.join(codexHome(), 'agents'),
    path.join(project, '.claude', 'agents'),
    path.join(project, '.codex', 'agents'),
    path.join(project, '.agents', 'agents'),
  ];
}

/** run 产物根目录：<项目根>/.codex/workflows-runs */
export function transcriptRoot(cwd = process.cwd()) {
  return process.env.CDW_TRANSCRIPT_ROOT || path.join(findProjectRoot(cwd), '.codex', 'workflow-runs');
}

/** 列出所有可用的命名 workflow，同名时后搜索到的覆盖前面的 */
export function listWorkflowFiles(cwd = process.cwd(), dirs = workflowDirs(cwd)) {
  const found = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const file = path.join(dir, entry.name);
      try {
        const { meta } = parseMeta(fs.readFileSync(file, 'utf8'));
        found.set(meta.name, file);
      } catch { /* Invalid scripts cannot be registered by meta.name. */ }
    }
  }
  return found;
}
