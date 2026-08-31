export const meta = {
  name: 'review-changes',
  description: '分维度审查当前代码改动，并对每条发现做对抗式验证后输出确认清单',
  whenToUse: '改动写完、提交之前，想要一份经过交叉验证、误报率低的问题清单时',
  phases: [
    { title: 'Review', detail: '按维度并行审查 diff' },
    { title: 'Verify', detail: '每条发现派独立验证者尝试证伪' },
  ],
};

// args: { diffCommand?: string, dimensions?: string[] }
const diffCommand = (args && args.diffCommand) || 'git diff HEAD';

const ALL_DIMENSIONS = {
  correctness: '逻辑正确性：边界条件、空值、错误路径、状态机漏态、off-by-one',
  security: '安全：注入、越权、未校验输入、敏感信息泄露、不安全的默认值',
  concurrency: '并发：竞态、共享可变状态、锁顺序、异步错误吞掉',
  resource: '资源：泄漏、未关闭句柄、无界增长的缓存与队列',
  api: '接口契约：向后兼容性、错误码语义、字段可空性与调用方假设',
};

const selected =
  args && Array.isArray(args.dimensions) && args.dimensions.length > 0
    ? args.dimensions.filter((d) => ALL_DIMENSIONS[d])
    : Object.keys(ALL_DIMENSIONS);

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          summary: { type: 'string' },
          failureScenario: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
};

phase('Review');
log(`审查 ${selected.length} 个维度，diff 来源：${diffCommand}`);

const perDimension = await pipeline(
  selected,
  (dimension) =>
    agent(
      `请先运行 \`${diffCommand}\` 取得改动内容，然后只从这一个维度审查：\n\n` +
        `【${dimension}】${ALL_DIMENSIONS[dimension]}\n\n` +
        `只报告你能给出具体失败场景（具体输入/状态 → 具体错误结果）的问题。` +
        `风格偏好、命名争议、"可以更优雅"一律不报。没有问题就返回空数组。`,
      { label: `review:${dimension}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
  // 每个维度一审完就立刻进验证，不等其他维度
  (review, dimension) =>
    parallel(
      ((review && review.findings) || []).map((finding) => () =>
        agent(
          `请尝试**推翻**下面这条代码审查发现。默认立场是它不成立，只有当你能在源码中确认具体失败路径时才判为成立。\n\n` +
            `文件：${finding.file}:${finding.line}\n` +
            `结论：${finding.summary}\n` +
            `声称的失败场景：${finding.failureScenario}`,
          {
            label: `verify:${finding.file}:${finding.line}`,
            phase: 'Verify',
            agentType: 'verifier',
            schema: VERDICT_SCHEMA,
          },
        ).then((verdict) => ({ ...finding, dimension, verdict })),
      ),
    ),
);

const all = perDimension.flat().filter(Boolean);
const confirmed = all.filter((f) => f.verdict && f.verdict.real);
const rejected = all.length - confirmed.length;

log(`共 ${all.length} 条发现，验证后确认 ${confirmed.length} 条，证伪 ${rejected} 条`);

const order = { high: 0, medium: 1, low: 2 };
confirmed.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

return {
  confirmed,
  stats: { raised: all.length, confirmed: confirmed.length, rejected },
};
