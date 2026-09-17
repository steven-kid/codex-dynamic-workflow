/**
 * 子 agent 的 prompt 组装。
 *
 * 关键约定（与 Claude Code Dynamic Workflow 对齐）：
 * 子 agent 被明确告知「你的最终输出就是返回值，不是给人看的消息」，
 * 这样它才会直接吐数据而不是「好的，我已经帮你分析完了……」。
 */

const RETURN_VALUE_CONTRACT = `你正作为一个自动化 workflow 中的子 agent 运行。

这是一个有界的子任务。只完成给定任务，不要调用 workflow 或再派发子 agent；不要安装、升级或更新插件、工具及全局配置。

输出契约（必须遵守）：
- 你的最终消息**就是**这次调用的返回值，会被程序直接消费，不是给人阅读的汇报。
- 不要写开场白、寒暄、"我已经完成了"之类的元叙述，也不要复述任务本身。
- 只输出结果内容本身。`;

const STRUCTURED_CONTRACT = `
- 本次调用要求结构化输出：你的最终消息必须是**单个 JSON 值**，严格符合下面的 JSON Schema。
- 不要加 \`\`\` 代码围栏，不要在 JSON 前后附加任何文字。

JSON Schema:
`;

/**
 * @param {object} p
 * @param {string} p.prompt 用户在脚本里写的任务描述
 * @param {object|null} p.schema 结构化输出 schema（保留原始语义）
 * @param {string} p.agentSystemPrompt 来自 agentType 定义的追加 system prompt
 * @param {string|null} p.phase 当前 phase 名，作为上下文提示
 * @param {string|null} p.correction schema 校验失败后的纠正说明
 */
export function buildAgentPrompt({
  prompt,
  schema = null,
  agentSystemPrompt = '',
  phase = null,
  correction = null,
}) {
  const sections = [RETURN_VALUE_CONTRACT];

  if (schema) {
    sections.push(STRUCTURED_CONTRACT + JSON.stringify(schema, null, 2));
  }

  if (agentSystemPrompt?.trim()) {
    sections.push(`---\n\n${agentSystemPrompt.trim()}`);
  }

  if (phase) {
    sections.push(`当前阶段：${phase}`);
  }

  sections.push(`---\n\n# 任务\n\n${prompt}`);

  if (correction) {
    sections.push(
      `---\n\n# 上一次输出不合规，请修正\n\n${correction}\n\n请重新输出，只给 JSON，不要解释。`,
    );
  }

  return sections.join('\n\n');
}

/** 给子 workflow 的 agent 打标签时用：截断过长 prompt 做默认 label */
export function defaultLabel(prompt, index) {
  const firstLine = String(prompt).trim().split('\n')[0] ?? '';
  const short = firstLine.length > 48 ? `${firstLine.slice(0, 45)}...` : firstLine;
  return short || `agent-${index}`;
}
