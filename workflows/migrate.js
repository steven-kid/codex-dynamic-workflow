export const meta = {
  name: 'migrate',
  description: '批量迁移：发现改造点 → 每个点在独立 worktree 里改 → 逐个验证',
  whenToUse: '要在多个文件里做同一类机械改造（API 换代、依赖升级、模式替换）时',
  phases: [
    { title: 'Discover', detail: '找出所有需要改造的位置' },
    { title: 'Transform', detail: '逐个改造（worktree 隔离）' },
    { title: 'Verify', detail: '逐个验证改造结果' },
  ],
};

// args: { instruction, discoverHint?, verifyCommand?, isolate?: boolean }
const instruction = typeof args === 'string' ? args : args && args.instruction;
if (!instruction) {
  throw new Error('migrate 需要 args.instruction，说明要做什么改造');
}
const verifyCommand = (args && args.verifyCommand) || null;
const isolate = args && args.isolate === true;

const SITES_SCHEMA = {
  type: 'object',
  properties: {
    sites: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
};

phase('Discover');
const discovery = await agent(
  `请找出仓库中所有需要做下面这项改造的文件，只列文件和原因，不要动手改：\n\n${instruction}\n\n` +
    ((args && args.discoverHint) ? `检索提示：${args.discoverHint}\n\n` : '') +
    `用 grep 穷尽式检索，不要只看明显的几个。把确实不需要改的排除掉。`,
  { label: 'discover', phase: 'Discover', agentType: 'explorer', schema: SITES_SCHEMA },
);

const sites = (discovery && discovery.sites) || [];
if (sites.length === 0) {
  log('没有找到需要改造的位置');
  return { sites: [], results: [] };
}
log(`找到 ${sites.length} 个改造点${isolate ? '，将在独立 worktree 中并行改造' : ''}`);

// pipeline 而非 parallel：每个文件改完立刻验证，不等其他文件
const results = await pipeline(
  sites,
  (site, _original, index) =>
    agent(
      `请在文件 ${site.file} 中完成下面这项改造：\n\n${instruction}\n\n` +
        `该文件被选中的原因：${site.reason}\n\n` +
        `只改这一个文件，不要顺手改别处。改完自检语法与引用。`,
      {
        label: `transform:${site.file}`,
        phase: 'Transform',
        agentType: 'implementer',
        isolation: isolate ? 'worktree' : undefined,
        // 与下一阶段共用同一个 key，让验证者进到改造实际发生的 worktree
        worktreeKey: isolate ? 'migrate-site-' + index : undefined,
      },
    ),
  (transformResult, site, index) =>
    agent(
      `请检查文件 ${site.file} 上刚完成的改造是否正确、完整。\n\n` +
        `改造要求：${instruction}\n\n执行者的说明：${transformResult}\n\n` +
        (verifyCommand ? `请运行 \`${verifyCommand}\` 验证。\n\n` : '') +
        `重点检查：有没有漏改的地方、有没有改坏原有逻辑、引用是否仍然成立。`,
      {
        label: `verify:${site.file}`,
        phase: 'Verify',
        agentType: 'verifier',
        schema: VERIFY_SCHEMA,
        // 必须落在改造所在的 worktree，否则读到的是主工作区的旧文件
        isolation: isolate ? 'worktree' : undefined,
        worktreeKey: isolate ? 'migrate-site-' + index : undefined,
      },
    ).then((verdict) => ({ file: site.file, transform: transformResult, verdict })),
);

const done = results.filter(Boolean);
const failed = done.filter((r) => r.verdict && r.verdict.ok === false);
log(`改造完成 ${done.length}/${sites.length}，其中 ${failed.length} 个未通过验证`);

return {
  total: sites.length,
  succeeded: done.length - failed.length,
  failed,
  results: done,
};
