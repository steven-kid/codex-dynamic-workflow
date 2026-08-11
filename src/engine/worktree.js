/**
 * worktree 隔离：给 agent 一份独立的 git worktree，
 * 让并行改同一批文件的 agent 不互相踩踏。
 *
 * 代价不小（每个 ~200-500ms + 磁盘），只有 opts.isolation === 'worktree' 才启用。
 * 如果 agent 跑完没有任何改动，worktree 会被自动清掉。
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(cwd) {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], cwd)) === 'true';
  } catch {
    return false;
  }
}

/**
 * 创建一个 worktree，返回 { path, branch, cleanup, hasChanges }。
 * 调用方负责在 agent 结束后调用 finalize()。
 */
export async function createWorktree({ repoRoot, name }) {
  const root = await git(['rev-parse', '--show-toplevel'], repoRoot);
  const branch = `cdw/${name}`;
  const worktreeRoot = path.join(root, '.codex', 'worktrees');
  const worktreePath = path.join(worktreeRoot, name);

  await fsp.mkdir(worktreeRoot, { recursive: true });

  let head = 'HEAD';
  try {
    await git(['rev-parse', '--verify', 'HEAD'], root);
  } catch {
    // 空仓库（还没有 commit）无法建 worktree
    throw new Error('当前仓库还没有任何 commit，无法创建 worktree 隔离');
  }

  // 记录基准 commit：finalize 时用它判断 agent 有没有提交东西。
  // 不能依赖 HEAD@{upstream}——新建分支没有 upstream，查询必然失败。
  const baseCommit = await git(['rev-parse', 'HEAD'], root);

  await git(['worktree', 'add', '--detach', worktreePath, head], root);
  try {
    await git(['switch', '-c', branch], worktreePath);
  } catch {
    // 分支重名时退回 detached HEAD，不影响 agent 干活
  }

  return {
    path: worktreePath,
    branch,
    baseCommit,
    /** 返回该 worktree 是否产生了改动；无改动则自动移除 */
    async finalize() {
      const dirty = await hasChanges(worktreePath, baseCommit);
      if (!dirty) {
        await removeWorktree(root, worktreePath, branch);
        return { kept: false, path: worktreePath, branch };
      }
      return { kept: true, path: worktreePath, branch };
    },
    async remove() {
      await removeWorktree(root, worktreePath, branch);
    },
  };
}

async function hasChanges(worktreePath, baseCommit) {
  try {
    const status = await git(['status', '--porcelain'], worktreePath);
    if (status.length > 0) return true;
    // 也算上已提交的 commit：与创建时记录的基准比对。
    // 此处一旦误判为「无改动」，agent 已提交的成果会被 removeWorktree 永久删除，
    // 所以任何判定失败都必须保守地当作有改动。
    if (!baseCommit) return true;
    const ahead = await git(['rev-list', '--count', `${baseCommit}..HEAD`], worktreePath);
    return Number(ahead) > 0;
  } catch {
    return true; // 判断不了就保守保留
  }
}

async function removeWorktree(root, worktreePath, branch) {
  try {
    await git(['worktree', 'remove', '--force', worktreePath], root);
  } catch {
    await fsp.rm(worktreePath, { recursive: true, force: true });
    await git(['worktree', 'prune'], root).catch(() => {});
  }
  await git(['branch', '-D', branch], root).catch(() => {});
}
