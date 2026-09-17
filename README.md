# Codex Dynamic Workflow

把「需要很多 agent 协作」的任务，写成一段**确定性的 JavaScript 编排脚本**，交给 Codex 执行。

控制流由代码决定（循环、条件、fan-out、投票），而不是由模型每一步自由发挥——这是它相对「让主 agent 自由调度子 agent」的核心差异：**可复现、可预算、可断点续跑**。

本项目是 Claude Code Dynamic Workflow 的 Codex 对标实现，以 Codex 插件形式分发。

---

## 一、快速开始

### 1.1 安装

```bash
# 注册本地 marketplace 并安装
codex plugin marketplace add /path/to/codex-dynamic-workflow
codex plugin add codex-dynamic-workflow@codex-dynamic-workflow

# 确认 MCP server 已注册
codex mcp list
```

安装后 Codex 会自动加载三样东西：

| 组件 | 作用 |
| --- | --- |
| MCP server `dynamic-workflow` | 向主 agent 暴露 `workflow_run` 等 5 个工具 |
| skill `dynamic-workflow` | 教主 agent 何时该开 workflow、怎么写脚本 |
| 5 个内置 workflow + 4 个 agentType | 开箱即用的编排模板 |

零 npm 依赖，只需要 Node ≥ 20。

### 1.2 两种使用方式

**方式一：在 Codex 会话里直接说**

```
用 workflow 并行审一遍我这次的改动
```

主 agent 识别到编排意图后会调用 `workflow_run`。注意触发是有门槛的——见 [§5 触发门槛](#五触发门槛)。

**方式二：命令行直接跑**

```bash
node bin/cdw.js run --name review-changes
node bin/cdw.js run ./my-workflow.js --args '{"target":"src/"}' --budget 500000
```

### 1.3 第一个脚本

```js
export const meta = {
  name: 'hello-workflow',
  description: '三个 agent 并行干活',
}

phase('Work')
const results = await parallel([
  () => agent('总结 README 的核心功能'),
  () => agent('列出 package.json 里的运行时依赖'),
  () => agent('找出仓库里最大的三个源文件'),
])
return results
```

```bash
node bin/cdw.js validate ./hello.js   # 先校验（不花钱）
node bin/cdw.js run ./hello.js        # 再执行
```

---

## 二、编排原语

脚本体在 async 上下文中运行，可直接 `await`。以下标识符已注入为全局：

### `agent(prompt, opts?)`

派发一个 codex 子 agent。**有 `schema` 时返回校验过的对象，否则返回字符串**。

```js
const text = await agent('总结这个模块的职责')

const data = await agent('找出所有 TODO', {
  label: 'scan:todos',        // 进度显示用的标签
  phase: 'Scan',              // 显式归入某个 phase 分组
  schema: TODO_SCHEMA,        // 结构化输出（见 §3）
  model: 'o3',                // 覆盖默认模型
  effort: 'high',             // minimal | low | medium | high | xhigh
  sandbox: 'read-only',       // read-only | workspace-write | danger-full-access
  agentType: 'explorer',      // 使用预设的 agent 人设（见 §4）
  isolation: 'worktree',      // 独立 git worktree，防并行写冲突
  worktreeKey: 'site-0',      // 同 key 的 agent 共用一份 worktree（多阶段读同一份改动）
  timeoutMs: 600000,          // 单 agent 超时
  cwd: '/path/to/subrepo',    // 覆盖工作目录
})
```

在 `parallel` / `pipeline` 内部，失败的 agent **降级为 `null`** 而不是炸掉整个 run —— 所以记得 `.filter(Boolean)`。

### `pipeline(items, ...stages)` —— 默认首选

**无屏障**流水线。每个 item 独立穿过所有 stage：item A 可以在 stage 3，而 item B 还在 stage 1。

```js
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { schema: FINDINGS }),          // stage 1
  (review, original, index) => verify(review),           // stage 2
)
```

每个 stage 的签名都是 `(prevResult, originalItem, index)`——后面的 stage 可以直接拿到原始 item 和下标，不用把它们塞进上一个 stage 的返回值里传递。

某个 stage 抛错时，**该 item 降级为 `null` 并跳过剩余 stage**，其他 item 不受影响。

### `parallel(thunks)` —— 屏障

并发执行并**等齐所有结果**。普通分支失败解析为 `null`；取消、预算耗尽、脚本错误和运行上限会终止整个 run。

```js
const votes = await parallel([
  () => agent('从正确性角度判断'),
  () => agent('从安全角度判断'),
  () => agent('从可复现角度判断'),
])
const yes = votes.filter(Boolean).filter((v) => v.real).length
```

**什么时候才该用屏障？** 只有下一阶段确实需要上一阶段的**全部**结果时：

- 跨条目去重/合并，然后再做昂贵的下游处理
- 总数为 0 时提前退出（「没发现问题 → 整个验证阶段跳过」）
- 下一阶段的 prompt 里要引用「其他的发现」做横向比较

**这些不构成用屏障的理由：**

- 「我得先 flatten / map / filter 一下」——把 transform 放进 pipeline 的一个 stage 里即可：
  `pipeline(items, stageA, (r) => transform([r]).flat(), stageB)`
- 「这两个阶段概念上是分开的」——pipeline 建模的就是这个。阶段分离 ≠ 阶段同步。
- 「这样代码更清晰」——屏障的延迟代价是真实的。5 个 finder 里最慢的比最快的慢 3 倍，屏障就浪费掉快的那些 2/3 的时间。

拿不准时：用 pipeline。

### `phase(title)` / `log(message)`

```js
phase('Review')          // 后续 agent 归入此分组
log('共 12 个待审文件')   // 叙述行，显示在进度树上方
```

### `args`

调用方传入的参数，原样透传。传数组就是数组，不会被 JSON 字符串化。

```js
const target = (args && args.target) || 'src/'
```

```bash
node bin/cdw.js run wf.js --args '{"target":"src/api"}'
node bin/cdw.js run wf.js --args @params.json
```

### `budget`

```js
budget.total        // 预算总额（output tokens），未设置时为 null
budget.spent()      // 本次 run 已消耗的 output tokens
budget.remaining()  // max(0, total - spent)；未设预算时为 Infinity
```

预算是**停止派发的阈值，不是计费硬上限**：用尽后再调 `agent()` 会直接抛错；已经运行的请求可能超额。结束时超出预算的 run 也会标记为 `budget_exhausted`。预算只统计 output tokens，不代表总费用。

```js
// 按预算动态决定深度。注意必须 guard budget.total —— 
// 没设预算时 remaining() 是 Infinity，循环会一路撞到 1000 agent 的上限
while (budget.total && budget.remaining() > 50000) {
  const round = await agent('继续找 bug', { schema: BUGS })
  bugs.push(...round.bugs)
  log(`${bugs.length} 条，剩余预算 ${Math.round(budget.remaining() / 1000)}k`)
}
```

### `workflow(nameOrRef, args)`

内联执行另一个 workflow，返回它的返回值。子 workflow **共享**父级的并发槽位、agent 计数、预算和中止信号。

```js
const scan = await workflow('understand-codebase', { target: 'src/' })
const custom = await workflow({ scriptPath: './my-sub.js' }, { x: 1 })
```

只支持**一层**嵌套——子 workflow 里再调 `workflow()` 会报错。

---

## 三、结构化输出

给 `agent()` 传 `schema` 后，返回值就是校验过的 JS 对象，不需要自己解析。

```js
const FINDINGS = {
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
        },
      },
    },
  },
}

const result = await agent('审查这个文件', { schema: FINDINGS })
result.findings.forEach((f) => log(`${f.file}:${f.line}`))
```

**你不需要手写 strict 模式那一堆样板。** Codex 底层走 OpenAI Structured Outputs 严格模式，要求每个 object 都显式写 `additionalProperties: false`、`required` 必须列全所有 property。引擎会**自动递归补齐**这些字段（含 `$defs`、`anyOf` 分支、数组 items）。

要表达「可选字段」，用 nullable 而不是省略：`{ type: ['string', 'null'] }`。

**校验失败会自动纠正重试一次**：模型返回的 JSON 解析不出来、或形状不符 schema 时，引擎会把具体的错误信息回灌给模型让它重来，而不是把脏数据交给下游 stage。

> 实现细节：Codex 有个已知行为（openai/codex#19816），schema 会被施加到一个 turn 内**每一条** agent_message 上，包括工具调用前的中间播报。所以不能用「第一条合法 JSON」当结果。本引擎优先读取 `--output-last-message` 写出的文件，天然取到最后一条。

---

## 四、agentType：预设人设

除了逐个参数传，也可以把「模型 + 档位 + 沙箱 + system prompt」打包成一个 agentType。

内置四个：

| agentType | 用途 | 默认配置 |
| --- | --- | --- |
| `general-purpose` | 未指定时的兜底 | 继承 run 级默认值 |
| `explorer` | 只读检索定位，不改文件 | `read-only` · `low` |
| `verifier` | 对抗式验证，默认立场是证伪 | `read-only` · `high` |
| `implementer` | 落地改动 | `workspace-write` · `medium` |

```js
await agent('这条发现成立吗？', { agentType: 'verifier' })
```

**自定义**：在 `<项目根>/.codex/agents/` 或 `$CODEX_HOME/agents/` 放一个 `.md` 文件。

```markdown
---
name: security-auditor
description: 专注安全问题的审查者
model: o3
effort: high
sandbox: read-only
---

你是一个安全审查专家。重点关注注入、越权、敏感信息泄露。
对每个发现，必须给出可复现的攻击路径，给不出的不要报。
```

正文会作为额外的 system prompt 追加给该 agent。查看当前可用的：`node bin/cdw.js agents`。

---

## 五、触发门槛

`workflow_run` 一次可能拉起数十个 codex 子进程，成本可观。**只有用户明确表达了编排意图时才应调用**：

- 用户说了「用 workflow 跑」「并行铺开 agent」「fan out」「orchestrate」「ultracode」等；
- 用户点名要跑某个命名 workflow；
- 用户调用的 skill / slash command 指示要用它。

**「这任务并行会更快」本身不构成理由。** 这种情况下正确的做法是：简单说明可以开 workflow、大致成本，然后问用户要不要开。

值得开 workflow 的三种情形：

1. **要全面** —— 拆解后并行覆盖（多维度 review、全仓审计、多源调研）
2. **要有把握** —— 独立视角 + 对抗式检验后再下结论（judge panel、N 票否决）
3. **规模超出单上下文** —— 迁移、批量改写、大范围扫描

不值得的：单文件修改、解释代码、一两次搜索就能回答的问题。

---

## 六、内置 workflow

```bash
node bin/cdw.js list                                   # 列出全部
node bin/cdw.js show review-changes                    # 看某个的 meta
node bin/cdw.js run --name hunt-bugs --args '{"target":"src/"}'
```

| 名称 | 做什么 | 编排形态 |
| --- | --- | --- |
| `review-changes` | 分维度审查 diff，每条发现派独立验证者证伪 | pipeline + 对抗式验证 |
| `hunt-bugs` | 穷尽式搜寻，跑到连续 K 轮无新增为止 | loop-until-dry + 三镜头投票 |
| `design-panel` | N 个立场独立出方案，交叉打分后综合 | judge panel |
| `understand-codebase` | 五个切面并行通读，综合成架构地图 | 多模态扫描 + 综合 |
| `migrate` | 发现改造点 → worktree 隔离改造 → 逐个验证 | pipeline + worktree |

参数：

```bash
# review-changes
--args '{"diffCommand":"git diff main","dimensions":["security","concurrency"]}'

# hunt-bugs
--args '{"target":"src/auth","maxRounds":4,"dryRounds":2}'

# design-panel
--args '{"question":"要不要引入缓存层"}'

# migrate
--args '{"instruction":"把 var 换成 const","verifyCommand":"npm test","isolate":true}'
```

---

## 七、质量模式

这些是常见形态，按任务挑、可自由组合，也可以自创：

**对抗式验证** —— 每条发现派 N 个独立「证伪者」，多数判否即丢弃。防止看似合理实则错误的结论蒙混过关。

```js
const votes = await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(`请尝试推翻：${claim}。不确定时默认判为不成立。`, { schema: VERDICT })),
)
const survives = votes.filter(Boolean).filter((v) => !v.refuted).length >= 2
```

**视角分化验证** —— 当一条结论可能以多种方式出错时，给每个验证者**不同镜头**（正确性 / 安全 / 性能 / 能否复现），而不是 N 个同质验证者。多样性能覆盖冗余覆盖不到的失败模式。

**Judge panel** —— 从不同角度生成 N 个方案，并行打分，按赢家综合并嫁接亚军的亮点。解空间开阔时，这比「一个方案反复迭代」更好。

**跑到枯竭** —— 发现类任务（找 bug、找边界）循环到连续 K 轮无新增为止。简单的 `while (count < N)` 会漏掉长尾。

> 关键细节：去重要对**所有见过的**去重，不是对**已确认的**去重。否则被评委否掉的发现每轮都会重新冒出来，永远收敛不了。

**多模态扫描** —— 多个 agent 各用不同检索角度（按容器 / 按内容 / 按实体 / 按时间）。每个都看不到别人找到的东西，适合单一检索角度覆盖不全的场景。

**完备性批判者** —— 最后派一个 agent 专门问「还缺什么——哪种检索没跑、哪条断言没验、哪个来源没读」。它找出来的就是下一轮的工作。

**不许静默截断** —— 如果脚本做了 top-N、抽样、不重试，必须 `log()` 出来。静默截断会被读成「已经全覆盖了」，而实际没有。

### 规模怎么定

按用户的要求定档：「随便看看有没有 bug」→ 少量 finder、单票验证；「彻底审一遍」「要全面」→ 更大的 finder 池、3–5 票对抗验证、加一个综合阶段。拿不准时，调研/审查/审计类偏向彻底，快速确认类偏向精简。

---

## 八、断点续跑

每次 run 都会把脚本存档到 `<项目根>/.codex/workflow-runs/<runId>/`，并返回 `runId`。

```bash
node bin/cdw.js run ./wf.js                   # 第一次跑，记下 runId
# ...改脚本...
node bin/cdw.js run ./wf.js --resume wf_abc123
```

**语义是「最长未变前缀」**：从头开始逐个比对每次 `agent()` 调用的指纹（prompt + 影响执行的 opts），一路命中缓存直到遇到第一个改动过的调用，从那里开始全部重跑。

- 脚本完全没改 → 可复用的调用命中缓存
- 改了中间某个 agent → 它之前的复用，它和它之后的重跑

指纹覆盖**最终真正送给模型的输入**，而不只是脚本里写的原始 opts：`prompt` `phase` 以及解析完多级默认值后的 `model` `effort` `sandbox`，外加 `schema` `agentType` `agentSystemPrompt` `isolation` `worktreeKey` `cwd`。

这意味着改 `phase` 名、改 agentType 定义文件的正文、改 run 级默认 model，都会正确地让缓存失效——它们都会改变模型看到的提示词。改 `label` 这种纯展示字段则不会导致重跑。

模拟运行和真实运行不共享结果缓存。缓存命中会写入本次 journal，支持连续恢复。带 worktree 隔离的调用从该位置开始重跑，避免复用文本却没有恢复对应文件状态。

**正因如此，脚本里禁用了 `Date.now()`、`new Date()`（无参）、`Math.random()`** —— 它们会让同一段脚本每次产生不同的 prompt，缓存永远失效。需要时间戳就通过 `args` 传进来；需要制造差异就用 `index` 或 label。

### 排查「为什么结果是空的」

**先看 journal，别猜。**

```bash
node bin/cdw.js runs                    # 找到 runId
cat .codex/workflow-runs/<runId>/journal.jsonl
```

journal 逐条记录了每个 agent 的真实返回值、耗时、重试次数、thread_id。在 Codex 会话里可以直接用 `workflow_inspect` 工具读。

产物目录还包含：

| 文件 | 内容 |
| --- | --- |
| `journal.jsonl` | 每个 agent 的输入指纹与返回值，resume 的依据 |
| `summary.json` | 最终结果、usage、状态、耗时 |
| `workflow.js` | 本次执行的脚本存档 |

---

## 九、MCP 工具

插件向 Codex 主 agent 暴露 5 个工具：

| 工具 | 用途 |
| --- | --- |
| `workflow_run` | 执行内联脚本 / 脚本文件 / 命名 workflow |
| `workflow_list` | 列出命名 workflow 与可用 agentType |
| `workflow_validate` | 只校验 meta 与语法，不执行（写完先跑这个，便宜得多） |
| `workflow_runs` | 列出历史 run，找可 resume 的 runId |
| `workflow_inspect` | 读某次 run 的 journal，看每个 agent 的真实返回值 |

`workflow_run` 必须显式传入目标项目的绝对路径 `cwd`。MCP 进程从插件目录启动，不能用其工作目录推断用户项目。

`workflow_run` 执行期间会通过 MCP 进度通知实时汇报阶段与 agent 状态。

---

## 十、CLI 参考

```
cdw run <script.js|-> [选项]     执行脚本（- 表示从 stdin 读）
cdw run --name <name> [选项]     执行命名 workflow
cdw list                         列出命名 workflow
cdw show <name>                  查看某个 workflow 的 meta
cdw agents                       列出可用 agentType
cdw runs [--limit N]             列出历史 run
cdw resume <runId> [选项]        从历史 run 恢复
cdw validate <script.js>         只校验，不执行
cdw mcp                          以 MCP stdio server 运行
```

| 选项 | 说明 |
| --- | --- |
| `--args <json>` | 传给脚本的 args，支持内联 JSON 或 `@文件` |
| `--budget <n>` | output token 派发阈值 |
| `--concurrency <n>` | 并发上限，默认 `min(16, cpu-2)` |
| `--model` / `--effort` / `--sandbox` | run 级默认值，可被 agent opts 覆盖 |
| `--cwd <dir>` | 工作目录 |
| `--dry-run` | 不调模型，用占位结果验证控制流 |
| `--json` | 输出完整 summary |
| `--quiet` | 不渲染进度树 |
| `--full-auto` | 给子 agent 加 `--dangerously-bypass-approvals-and-sandbox` |

`--dry-run` 很值得用：它按 schema 合成占位结果，把脚本的循环、分支、空结果处理全跑一遍，一个 token 都不花。

---

## 十一、限制与约束

| 限制 | 值 | 说明 |
| --- | --- | --- |
| 单次 `parallel`/`pipeline` 条目 | 4096 | 超出直接报错，不静默截断 |
| 单次 run 的 agent 总数 | 1000 | 失控回路兜底 |
| `workflow()` 嵌套层数 | 1 | 子 workflow 内不能再嵌套 |
| 并发 agent | `min(16, cpu-2)` | 容器内按 cgroup CPU 配额收敛 |
| 单 agent 超时 | 30 分钟 | 可用 `opts.timeoutMs` 覆盖 |

**脚本是 JavaScript，不是 TypeScript。** 类型标注（`: string[]`）、interface、泛型都会直接语法报错。

**沙箱：** 脚本运行在独立的 vm context 里，只有 JS 语言内建能力（`JSON`、`Promise`、数组/字符串方法等）。`fetch`、`process`、`require`、`setTimeout`、模块 import 一概不可用——I/O 交给子 agent 去做。`process` 不可见同时意味着脚本读不到环境变量。

**禁用的 API：** `Date.now()`、无参 `new Date()`、`Math.random()`（破坏 resume 确定性）。这三项在 context 层面拦截，`globalThis.Date.now()` 一类写法同样绕不过去。带参数的 `new Date(ts)` 仍可用。

> 因为脚本在独立 realm 中运行，它返回的对象原型与宿主不同。引擎在出口用 `structuredClone` 归一，消费方拿到的是正常的宿主对象。

---

## 十二、工程结构

```
codex-dynamic-workflow/
├── .codex-plugin/plugin.json     插件清单
├── .mcp.json                     MCP server 声明
├── .agents/plugins/marketplace.json
├── bin/cdw.js                    CLI 入口
├── src/
│   ├── cli.js                    命令实现
│   ├── engine/
│   │   ├── runner.js             编排核心：钩子、并发、预算、resume
│   │   ├── codex.js              codex exec 适配与事件解析
│   │   ├── script.js             meta 解析与脚本编译
│   │   ├── schema.js             strict schema 规范化与校验
│   │   ├── journal.js            journal 与 resume 缓存
│   │   ├── agents.js             agentType 注册表
│   │   ├── worktree.js           git worktree 隔离
│   │   ├── semaphore.js          并发信号量
│   │   ├── prompt.js             子 agent prompt 组装
│   │   ├── constants.js          常量与 cgroup 感知的并发计算
│   │   └── errors.js             错误分类
│   ├── mcp/{protocol,server}.js  零依赖 MCP stdio server
│   └── util/{paths,progress}.js  路径解析与进度渲染
├── workflows/                    5 个内置 workflow
├── agents/                       4 个内置 agentType
├── skills/dynamic-workflow/      教主 agent 怎么用
└── test/                         88 个测试
```

### 测试

```bash
npm test
```

88 个测试，分三层：

- **单元测试** —— schema 规范化、meta 解析、事件解析、信号量、指纹
- **集成测试** —— 用 `test/fixtures/fake-codex.js` 桩替代真实 codex 二进制，真实拉起子进程走完整的 JSONL 事件解析，覆盖 parallel/pipeline 语义、失败降级、预算硬上限、并发上限、resume 缓存、子 workflow 计数、中止信号
- **MCP + CLI 测试** —— 真实起 MCP server 子进程走 JSON-RPC 握手；所有内置 workflow 在 dry-run 下完整跑一遍

桩的存在是有意的：它让引擎的语义在无网络、无凭证的环境下也能被完整验证，CI 里同样跑得动。

脚本在禁用动态代码生成的独立 VM 上下文中执行，钩子边界仅交换 JSON 数据，不暴露宿主 Node 对象。Node VM 不是操作系统安全沙箱：只运行可信来源的 workflow，不用于托管恶意脚本。

### 真实模型验收（会消耗额度）

安装插件后，可以通过已安装副本的 MCP server 在独立测试仓库中验收：

```bash
node scripts/smoke-real.mjs /absolute/path/to/installed-plugin /absolute/path/to/results
```

脚本依次运行 `review-changes`、小规模 `design-panel` 和 worktree 隔离的 `migrate`；检查预置缺陷是否被确认、方案是否生成、迁移后真实文件与测试是否通过，以及主工作区是否保持原样。结果和 journal 保存在指定目录。它不包含在 `npm test` 中。

`import()` 在校验时被保守拒绝（字面量或注释中的同样写法也会触发）；需要加载模块的工作交给子 agent。
