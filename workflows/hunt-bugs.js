export const meta = {
  name: 'hunt-bugs',
  description: '穷尽式 bug 搜寻：多轮 fan-out 找 + 多镜头投票验证，跑到连续无新增为止',
  whenToUse: '要求「彻底查一遍」「穷尽式找问题」，或对一块关键代码做深度审计时',
  phases: [
    { title: 'Hunt', detail: '多角度并行搜寻' },
    { title: 'Judge', detail: '多镜头投票裁决' },
  ],
};

// args: { target?: string, maxRounds?: number, dryRounds?: number }
const target = (args && args.target) || '整个仓库';
const maxRounds = (args && args.maxRounds) || 4;
const dryLimit = (args && args.dryRounds) || 2;

const HUNTERS = [
  '空值与未初始化：可能为 null/undefined 却未检查就解引用的地方',
  '边界与越界：数组下标、切片、循环终止条件、off-by-one',
  '错误处理：被吞掉的异常、只打日志不处理、错误路径上的资源泄漏',
  '并发：竞态、非原子的读改写、共享可变状态、异步顺序假设',
  '契约违背：调用方与被调方对参数/返回值的假设不一致',
];

const LENSES = ['correctness', 'security', 'reproducibility'];

const BUGS_SCHEMA = {
  type: 'object',
  required: ['bugs'],
  additionalProperties: false,
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'title', 'failureScenario'],
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          title: { type: 'string' },
          failureScenario: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['real', 'reasoning'],
  additionalProperties: false,
  properties: {
    real: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
};

const seen = new Set();
const confirmed = [];
let dryRounds = 0;
let round = 0;

const keyOf = (bug) => `${bug.file}:${bug.line}:${bug.title}`;

while (dryRounds < dryLimit && round < maxRounds) {
  round += 1;

  // 预算守卫：没设预算时 remaining() 是 Infinity，这里只在设了预算时提前收手
  if (budget.total && budget.remaining() < 50000) {
    log(`预算仅剩 ${budget.remaining()} output tokens，提前结束搜寻`);
    break;
  }

  phase('Hunt');
  log(`第 ${round} 轮搜寻（已确认 ${confirmed.length} 条，连续空轮 ${dryRounds}）`);

  const found = (
    await parallel(
      HUNTERS.map((hunterPrompt, i) => () =>
        agent(
          `在 ${target} 中搜寻 bug，本轮只关注这一类：\n\n${hunterPrompt}\n\n` +
            `这是第 ${round} 轮搜寻，请刻意寻找与常见套路不同的角落（第 ${i + 1} 号搜寻者）。\n` +
            `只报告能给出具体失败场景的问题；给不出「具体输入 → 具体错误结果」的一律不报。`,
          { label: `hunt:r${round}:${i}`, phase: 'Hunt', schema: BUGS_SCHEMA },
        ),
      ),
    )
  )
    .filter(Boolean)
    .flatMap((r) => r.bugs || []);

  // 对「所有见过的」去重，而不是对「已确认的」——否则被否掉的会每轮重现，永不收敛
  const fresh = found.filter((bug) => !seen.has(keyOf(bug)));
  if (fresh.length === 0) {
    dryRounds += 1;
    log(`第 ${round} 轮无新增发现（连续 ${dryRounds}/${dryLimit}）`);
    continue;
  }
  dryRounds = 0;
  for (const bug of fresh) seen.add(keyOf(bug));

  phase('Judge');
  log(`第 ${round} 轮新增 ${fresh.length} 条，交由 ${LENSES.length} 个镜头投票`);

  const judged = await parallel(
    fresh.map((bug) => () =>
      parallel(
        LENSES.map((lens) => () =>
          agent(
            `请从【${lens}】这个视角判断下面这条发现是否真实成立。你的默认立场是**不成立**，` +
              `只有当你在源码中确认了具体失败路径才判为成立。\n\n` +
              `文件：${bug.file}:${bug.line}\n标题：${bug.title}\n声称的失败场景：${bug.failureScenario}`,
            { label: `judge:${lens}:${bug.file}`, phase: 'Judge', agentType: 'verifier', schema: VERDICT_SCHEMA },
          ),
        ),
      ).then((votes) => {
        const valid = votes.filter(Boolean);
        const yes = valid.filter((v) => v.real).length;
        return { bug, real: yes >= Math.ceil(LENSES.length / 2), votes: `${yes}/${valid.length}` };
      }),
    ),
  );

  for (const verdict of judged.filter(Boolean)) {
    if (verdict.real) confirmed.push({ ...verdict.bug, votes: verdict.votes, round });
  }
}

log(`搜寻结束：${round} 轮，累计发现 ${seen.size} 条，确认 ${confirmed.length} 条`);

return {
  target,
  rounds: round,
  raised: seen.size,
  confirmed,
};
