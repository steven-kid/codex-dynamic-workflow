export const meta = {
  name: 'understand-codebase',
  description: '多角度并行通读一个代码库/子系统，产出结构化的架构地图',
  whenToUse: '刚接手一个陌生仓库、或要在动手前搞清某个子系统的边界与数据流时',
  phases: [
    { title: 'Survey', detail: '并行扫描不同切面' },
    { title: 'Synthesize', detail: '综合成一份架构地图' },
  ],
};

// args: { target?: string, question?: string }
const target = (args && args.target) || '整个仓库';
const question = (args && args.question) || null;

const LENSES = [
  { key: 'entrypoints', prompt: '入口与启动路径：可执行入口、CLI、server 启动、初始化顺序、配置加载' },
  { key: 'domain', prompt: '领域模型：核心数据结构、状态机、它们之间的关系与不变量' },
  { key: 'dataflow', prompt: '数据流：请求/事件从进入到落地经过哪些层，每层做了什么变换' },
  { key: 'boundaries', prompt: '外部边界：依赖的外部服务、数据库、文件系统、网络调用、第三方库' },
  { key: 'testing', prompt: '测试与构建：怎么跑测试、怎么构建、CI 做了什么、覆盖到哪些路径' },
];

const MAP_SCHEMA = {
  type: 'object',
  required: ['summary', 'keyFiles', 'notes', 'openQuestions'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    keyFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'role'],
        additionalProperties: false,
        properties: { path: { type: 'string' }, role: { type: 'string' } },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
};

phase('Survey');
log(`从 ${LENSES.length} 个切面并行通读：${target}`);

const surveys = await parallel(
  LENSES.map((lens) => () =>
    agent(
      `请通读 ${target}，只从这一个切面总结：\n\n【${lens.key}】${lens.prompt}\n\n` +
        (question ? `读的过程中特别留意这个问题：${question}\n\n` : '') +
        `用 grep/find 定位，读片段而不是整文件。结论要落到具体文件路径。` +
        `不确定的地方放进 openQuestions，不要猜。`,
      { label: `survey:${lens.key}`, phase: 'Survey', agentType: 'explorer', schema: MAP_SCHEMA },
    ).then((result) => result === null ? null : ({ lens: lens.key, ...result })),
  ),
);

const valid = surveys.filter(Boolean);
log(`${valid.length}/${LENSES.length} 个切面完成`);

phase('Synthesize');
const synthesis = await agent(
  `下面是 ${valid.length} 位 agent 从不同切面对「${target}」的独立勘察结果。\n\n` +
    `请综合成一份架构地图：先给整体结论，再按子系统展开，标出关键文件与它们的职责，` +
    `最后列出各切面之间互相矛盾的地方、以及仍然没搞清楚的问题。\n\n` +
    `${JSON.stringify(valid, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high' },
);

return { target, lenses: valid, architectureMap: synthesis };
