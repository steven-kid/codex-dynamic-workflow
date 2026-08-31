export const meta = {
  name: 'design-panel',
  description: 'Judge panel：并行产出 N 个独立方案，交叉打分后综合出最终方案',
  whenToUse: '方案空间开阔、存在多种合理解法，想避免「一条路走到黑」时',
  phases: [
    { title: 'Propose', detail: '从不同立场独立出方案' },
    { title: 'Judge', detail: '并行打分' },
    { title: 'Synthesize', detail: '按赢家综合并嫁接亚军亮点' },
  ],
};

// args: 字符串问题，或 { question, angles?, criteria? }
const question = typeof args === 'string' ? args : args && args.question;
if (!question) {
  throw new Error('design-panel 需要 args.question（或直接把问题字符串作为 args 传入）');
}

const ANGLES = (args && args.angles) || [
  { key: 'mvp', prompt: '最小可行优先：怎样用最少的改动先跑通，后续再演进' },
  { key: 'risk', prompt: '风险优先：哪种做法最不容易出事，可回滚、可观测、失败面最小' },
  { key: 'user', prompt: '使用者优先：哪种做法对调用方/最终用户的心智负担最小' },
  { key: 'longterm', prompt: '长期演进优先：哪种做法在两年后仍然站得住，扩展点留在正确的位置' },
];

const CRITERIA = (args && args.criteria) || [
  '正确性与边界覆盖',
  '实现成本与改动面',
  '可回滚性与失败处理',
  '长期可维护性',
];

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    tradeoffs: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
};

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          proposal: { type: 'string' },
          score: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
    best: { type: 'string' },
  },
};

phase('Propose');
log(`从 ${ANGLES.length} 个立场并行出方案`);

const proposals = (
  await parallel(
    ANGLES.map((angle) => () =>
      agent(
        `请针对下面的问题给出一个完整方案。你的立场是【${angle.key}】：${angle.prompt}\n\n` +
          `先读相关代码再下结论，不要泛泛而谈。明确列出取舍与风险，不要只讲优点。\n\n` +
          `问题：${question}`,
        { label: `propose:${angle.key}`, phase: 'Propose', schema: PROPOSAL_SCHEMA, effort: 'high' },
      ).then((p) => ({ angle: angle.key, ...p })),
    ),
  )
).filter(Boolean);

if (proposals.length === 0) {
  throw new Error('所有方案 agent 都失败了，无法继续');
}

// 屏障在这里是必要的：打分需要看到全部方案才能横向比较
phase('Judge');
const judgements = (
  await parallel(
    CRITERIA.map((criterion) => () =>
      agent(
        `下面是针对同一问题的 ${proposals.length} 个候选方案。请只按这一条标准打分（0-10）并说明理由：\n\n` +
          `【评分标准】${criterion}\n\n` +
          `问题：${question}\n\n方案：\n${JSON.stringify(proposals, null, 2)}`,
        { label: `judge:${criterion}`, phase: 'Judge', schema: SCORE_SCHEMA, effort: 'high' },
      ).then((j) => ({ criterion, ...j })),
    ),
  )
).filter(Boolean);

const totals = new Map();
for (const judgement of judgements) {
  for (const entry of judgement.scores || []) {
    totals.set(entry.proposal, (totals.get(entry.proposal) || 0) + (entry.score || 0));
  }
}
const ranking = [...totals.entries()].sort((a, b) => b[1] - a[1]);
log(`打分完成：${ranking.map(([name, score]) => `${name}=${score}`).join(' · ')}`);

phase('Synthesize');
const final = await agent(
  `下面是 ${proposals.length} 个候选方案与 ${judgements.length} 位评委的打分。\n\n` +
    `请以得分最高的方案为主干，把其他方案中确实更优的局部设计嫁接进来，` +
    `产出一份可以直接执行的最终方案：分步骤、标明每步的验证方式、列出已知风险与回退路径。\n` +
    `如果评委之间存在实质分歧，请明确指出分歧点和你的取舍理由。\n\n` +
    `问题：${question}\n\n方案：\n${JSON.stringify(proposals, null, 2)}\n\n` +
    `评分：\n${JSON.stringify(judgements, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high' },
);

return { question, proposals, judgements, ranking, finalPlan: final };
