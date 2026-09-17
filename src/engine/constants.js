/**
 * 引擎常量与默认值。集中放置，便于文档与代码保持一致。
 */

import fs from 'node:fs';
import os from 'node:os';

/** 单次 parallel()/pipeline() 调用允许的最大条目数 */
export const MAX_ITEMS_PER_CALL = 4096;

/** 单个 workflow run 生命周期内允许 spawn 的 agent 总数上限（失控回路兜底） */
export const MAX_AGENTS_PER_RUN = 1000;

/** workflow() 嵌套层数：只允许一层子 workflow */
export const MAX_WORKFLOW_DEPTH = 1;

/** 单个 agent 的默认超时（毫秒） */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** agent 失败后的默认重试次数（不含首次） */
export const DEFAULT_MAX_RETRIES = 1;

/** 结构化输出 schema 校验失败时，额外给模型的纠正轮次 */
export const DEFAULT_SCHEMA_RETRIES = 5;

/** 合法的 reasoning effort 档位 */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 合法的 sandbox 模式，透传给 codex exec -s */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/**
 * 默认并发上限：min(16, cpu - 2)，与 Claude Code Dynamic Workflow 的口径一致。
 * 容器里 availableParallelism() 可能返回宿主核数，所以再用 cgroup 配额收敛一次。
 */
export function defaultConcurrency() {
  return Math.max(1, Math.min(16, cgroupAwareCpuCount() - 2));
}

let cachedCpuCount;

/** 逻辑核数与 cgroup CPU 配额取较小值 */
export function cgroupAwareCpuCount() {
  if (cachedCpuCount !== undefined) return cachedCpuCount;

  const logical =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  cachedCpuCount = Math.max(1, Math.min(logical, readCgroupCpuQuota() ?? logical));
  return cachedCpuCount;
}

/** 返回 cgroup 允许的核数，读不到返回 null */
function readCgroupCpuQuota() {
  // cgroup v2: "<quota|max> <period>"
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota && quota !== 'max' && Number(period) > 0) {
      return Math.max(1, Math.ceil(Number(quota) / Number(period)));
    }
  } catch {
    /* 落到 v1 */
  }
  // cgroup v1
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
    if (quota > 0 && period > 0) return Math.max(1, Math.ceil(quota / period));
  } catch {
    /* 不在容器内或无权读取 */
  }
  return null;
}
