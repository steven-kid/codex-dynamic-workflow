/**
 * 引擎错误类型。
 *
 * 设计原则：区分「用户脚本写错了」(WorkflowScriptError)、
 * 「引擎拒绝执行」(WorkflowLimitError / BudgetExhaustedError)
 * 与「子 agent 执行失败」(AgentError)。
 * 只有 AgentError 会被 parallel/pipeline 降级为 null，其余一律向上冒泡终止整个 run。
 */

export class WorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** meta 非法、脚本语法错误、非法调用姿势等 */
export class WorkflowScriptError extends WorkflowError {}

/** 触碰硬上限：并发项数、agent 总数、嵌套层数 */
export class WorkflowLimitError extends WorkflowError {}

/** token 预算耗尽 */
export class BudgetExhaustedError extends WorkflowError {
  constructor(message, { total, spent } = {}) {
    super(message);
    this.total = total;
    this.spent = spent;
  }
}

/** 单个 agent 执行失败（重试后仍失败 / 被用户跳过 / schema 校验不过） */
export class AgentError extends WorkflowError {
  constructor(message, { agentId, label, exitCode, cause, attempts } = {}) {
    super(message, cause ? { cause } : undefined);
    this.agentId = agentId;
    this.label = label;
    this.exitCode = exitCode;
    this.attempts = attempts;
  }
}

/** 整个 run 被中止（TaskStop / SIGINT / 超时） */
export class WorkflowAbortError extends WorkflowError {}
