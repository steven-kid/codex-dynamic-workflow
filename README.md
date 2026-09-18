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
| MCP server `dynamic-workflow` | 向主 agent 暴露 `workflow_run` 等 10 个工具 |
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
  effort: 'high',             // minimal | low | medium | high | xhigh | max
  sandbox: 'read-only',       // read-only | workspace-write | danger-full-access
  agentType: 'explorer',      // 使用预设的 agent 人设（见 §4）
  isolation: 'worktree',      // 独立 git worktree，防并行写冲突
  worktreeKey: 'site-0',      // 同 key 的 agent 共用一份 worktree（多阶段读同一份改动）
  timeoutMs: 600000,          // 单 agent 超时
  cwd: '/path/to/subrepo',    // 覆盖工作目录
})
```

`agent()` 在执行失败并耗尽重试后返回 `null`，包括单独调用。非法参数仍抛错。`pipeline` 遇到 `null` 会跳过该项的后续阶段；收集结果时记得处理空值。

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

并发执行并**等齐所有结果**。分支抛错或拒绝时该位置返回 `null`，其余分支继续。调用本身的参数校验错误和全局取消仍会抛出。预算用尽会停止新派发，保留已完成与正在运行的结果。

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
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'severity'],
        additionalProperties: false,
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
result?.findings.forEach((f) => log(`${f.file}:${f.line}`))
```

**引擎保留原始 JSON Schema 语义。** `required` 之外的属性可以省略，`additionalProperties` 不会被自动改写。已满足 Codex 严格输出子集的 schema 直接传给 `--output-schema`；其他 schema 使用提示词约束 JSON，再由打包的 Ajv 校验原始 schema。支持 draft-07、2019-09、2020-12（用 `$schema` 指定），包括组合条件、引用、数值/字符串约束等。

JSON 解析或 schema 校验失败最多纠正重试 5 次，仍失败返回 `null`；进程重试单独计数。内置 workflow 已明确声明自身需要的必填字段。
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

### 后台运行与控制（0.2.0）

```bash
node bin/cdw.js run ./wf.js --cwd /absolute/project --background --json
node bin/cdw.js status wf_ID --cwd /absolute/project
node bin/cdw.js pause wf_ID --cwd /absolute/project
node bin/cdw.js resume wf_ID --cwd /absolute/project
node bin/cdw.js cancel wf_ID --agent wf_ID-a1 --cwd /absolute/project
node bin/cdw.js cancel wf_ID --cwd /absolute/project
node bin/cdw.js save wf_ID --name reusable-review --cwd /absolute/project
```

这些运行管理功能对应 [Claude Code 官方的后台运行、暂停恢复、停止单个 agent、保存工作流](https://code.claude.com/docs/en/workflows#watch-the-run)，通过 CLI/MCP 提供操作入口。

- **后台运行**：一个独立 Node 进程拥有 run，关闭发起它的 CLI 或 MCP 连接后继续执行。`status` 返回阶段、agent ID、状态、最近工具事件和 token 用量；完整结果仍在 journal 中。
- **暂停**：停止新的派发与重试，已启动的模型调用继续结束；不对进程做冻结。如果所有工作已结束，run 可以正常完成。`resume` 在同一个进程中继续暂停的运行，不重放已完成步骤。
- **单 agent 停止**：可停止运行中或排队中的 agent。调用返回 `null`，pipeline 跳过对应条目的后续阶段；其他分支继续。停止记录视为失败，后续重放从该位置开始失效。
- **整体停止与恢复**：停止所有进程并等待退出，再保存最终 summary（保持兼容，取消的 status 为 `failed`，error 表示中止）。无脚本参数的 `resume` 使用存档脚本、args、模型等配置启动新 run，沿用最长未变前缀规则。原进程未退出时拒绝重放；同一后台 run 的自动重放只允许发起一次，新 ID 保存在 `relaunch.json`，后续管理新 ID。
- **异常退出**：worker 被强制杀死时，状态查询会显示 `interrupted`。缺少最终 summary 的运行不会自动重放；必须先检查原 agent 是否仍在运行、确认写操作结果，再显式开始新的运行。状态文件记录的 PID 用于保守检查，不能据此盲目终止未知进程。
- **保存**：默认写入项目 `.codex/workflows/<name>.js`；`--personal` 写入 `$CODEX_HOME/workflows`。改写 meta.name，保留脚本体；拒绝覆盖文件或经由 `.codex`／workflows 目录符号链接写入。

后台目录还包含 `config.json`（脚本参数）、`state.json`（实时状态）、`worker.log`。控制使用权限受限的本机 Unix socket；当前后台管理支持 macOS/Linux。原有同步运行入口不变。未移植 HTML 报告，也未实现 Claude 的单 agent 原地重启、云端恢复或订阅额度重置等待。

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

插件向 Codex 主 agent 暴露 10 个工具：

| 工具 | 用途 |
| --- | --- |
| `workflow_run` | 执行内联脚本 / 脚本文件 / 命名 workflow |
| `workflow_list` | 列出命名 workflow 与可用 agentType |
| `workflow_validate` | 只校验 meta 与语法，不执行（写完先跑这个，便宜得多） |
| `workflow_runs` | 列出历史 run，找可 resume 的 runId |
| `workflow_inspect` | 读某次 run 的 journal，看每个 agent 的真实返回值 |
| `workflow_status` | 查询后台运行、阶段、agent 状态、最近工具事件与用量 |
| `workflow_pause` | 暂停新派发，允许运行中的调用完成 |
| `workflow_resume` | 原地继续暂停的运行；使用存档参数重放已停止的运行 |
| `workflow_cancel` | 停止整个运行，或传 `agentId` 停止单个 agent |
| `workflow_save` | 保存存档脚本为项目／个人命名 workflow，拒绝覆盖 |

`workflow_run` 必须显式传入目标项目的绝对路径 `cwd`。MCP 进程从插件目录启动，不能用其工作目录推断用户项目。

`workflow_run` 默认保持同步返回并发送 MCP 进度通知。设置 `background: true` 时立即返回 `runId`，后台运行不依赖 MCP 连接存续；之后使用 `workflow_status` 查询状态。

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
cdw status <runId>               查看后台运行与 agent 状态
cdw pause <runId>                暂停新派发
cdw cancel <runId> [--agent id]  取消整个运行或单 agent
cdw save <runId> --name <name>   保存为命名 workflow，可加 --personal
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
| `--background` | 后台启动并立即返回 runId |
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
│   │   ├── schema.js             原始 schema 校验与严格输出适配
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

- **单元测试** —— schema 语义与校验、meta 解析、事件解析、信号量、指纹
- **集成测试** —— 用 `test/fixtures/fake-codex.js` 桩替代真实 codex 二进制，真实拉起子进程走完整的 JSONL 事件解析，覆盖 parallel/pipeline 语义、失败降级、预算派发阈值、并发上限、resume 缓存、子 workflow 计数、中止信号
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


## Claude Code workflow 兼容

对照 [Claude Code 官方 workflow 文档](https://code.claude.com/docs/en/workflows) 和本机官方 CLI 2.1.221 的 Workflow 类型、原语参考与运行时行为核对。兼容范围是脚本编排协议；不宣称 Codex 与 Claude 的模型、权限或宿主 UI 相同。

| 接口 | 行为 |
| --- | --- |
| `agent(prompt, {label, phase, schema, model, effort, isolation, agentType})` | 保留参数名；终态执行失败为 `null`；`effort` 支持 `low/medium/high/xhigh/max`，另保留 Codex 的 `minimal` |
| `parallel(thunks)` | 按输入顺序收集结果，分支拒绝为 `null`，等待其余分支 |
| `pipeline(items, ...stages)` | 等待 Promise 输入；stage 收到 `(prev, originalItem, index)`；`null` 短路；逐项独立运行 |
| `phase(title)`、`log(message)`、`args` | 同名使用，`args` 可以是任意 JSON 值，省略为 `undefined` |
| `workflow(nameOrRef, args?)` | 支持名称与 `{scriptPath}`，路径相对目标 `cwd`，嵌套一层，共享预算和并发 |
| `budget` | `total/spent()/remaining()`；统计本次插件 run，无法读取 Claude 主会话的整轮预算 |
| MCP `workflow_run` | `scriptPath` 优先于 `script`、再优先于 `name`；接受但忽略旧 `description/title`；额外要求目标项目绝对 `cwd` |

命名 workflow 以 **`meta.name`** 注册，文件名可以不同。同名覆盖顺序从低到高：插件内置 → `~/.claude/workflows`（支持 `CLAUDE_CONFIG_DIR`）→ `$CODEX_HOME/workflows` → 项目 `.claude/workflows` → `.codex/workflows` → `.agents/workflows`。Agent 目录同理。项目里的原 `.claude/workflows/*.js` 可以直接加载，不必复制或改扩展名。

Claude 模型别名不能作为 Codex 模型 ID 使用。通过调用参数配置映射，保留原脚本中的 `model: 'sonnet'` 等写法：

```sh
cdw run --name my-workflow --cwd /absolute/project \
  --model-map '{"sonnet":"gpt-6-astra","opus":"gpt-6-astra","haiku":"gpt-6-astra"}'
```

MCP 使用同名 `modelMap` 对象。映射目标请选账户可用的 Codex 模型；示例不是能力或成本等级的对应承诺。不指定模型时使用 Codex 默认模型；自定义 agent 的 `model: inherit` 继承 run 默认值。未映射的 Claude 模型会明确报错。

`.claude/agents` 支持 YAML frontmatter、正文提示、`name/description/model/effort`。Claude 特有的 `tools/disallowedTools/permissionMode/hooks/mcpServers/skills/memory/background/maxTurns/isolation` 尚不能等价迁移，选中这类 agent 会明确报错，需要在优先级更高的 `.codex/agents` 提供适配定义。Claude 宿主提供的内建 agent 类型和插件命名空间也不会自动出现。`isolation: 'worktree'` 使用本插件独立 worktree；`sandbox/worktreeKey/cwd/timeoutMs` 是 Codex 扩展。

其余边界：提供 CLI/MCP 后台运行管理，没有 Claude 原生 `/workflows` 交互面板；resume 使用本插件 journal；全局取消终止 run。VM 只供可信脚本，动态 import 被保守拒绝（包括字符串/注释里的 import 调用文本）。

开发时运行 `npm ci && npm run build:vendor` 可重建打包的 JSON Schema/YAML/meta 解析器；安装插件不需要 npm install。第三方版本、许可证随 `src/vendor` 一起分发。

新增兼容性实测脚本（会调用 2 个真实模型 agent，另运行 2 次缓存恢复）：

```sh
node scripts/smoke-compat-real.mjs /absolute/installed-plugin-root /absolute/output-dir
```

后台运行管理的真实模型验收（调用 2 个只读 agent，检查暂停期间第二个不启动、恢复与保存）：

```sh
node scripts/smoke-managed-real.mjs /absolute/installed-plugin-root /absolute/output-dir
```
