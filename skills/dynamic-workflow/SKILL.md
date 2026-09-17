---
name: dynamic-workflow
description: 用确定性 JS 脚本编排多个 codex 子 agent —— fan-out 并行、无屏障流水线、对抗式校验、judge panel、token 预算循环、断点续跑。当用户明确要求多 agent 编排（说「用 workflow 跑」「并行铺开 agent」「orchestrate 一下」「ultracode」），或要求执行某个已保存的命名 workflow，或任务规模大到单个上下文装不下（全仓审计、批量迁移、穷尽式 bug 搜寻）时使用。普通的单文件改动、问答、解释类任务不要用。
---

# Dynamic Workflow

把一次「需要很多 agent 协作」的任务，写成一段确定性的 JavaScript 编排脚本，
交给 `workflow_run` 工具执行。控制流由代码决定（循环、条件、fan-out），
而不是由模型每一步自由发挥——这是它相对「多轮自由调度子 agent」的核心价值。

## 何时使用

值得开 workflow 的三种情形：

1. **要全面** —— 需要拆解后并行覆盖（多维度 review、全仓审计、多源调研）。
2. **要有把握** —— 需要独立视角与对抗式检验后再下结论（judge panel、N 票否决）。
3. **规模超出单上下文** —— 迁移、批量改写、大范围扫描。

不值得的：单文件修改、解释代码、一两次搜索就能回答的问题。这些直接做更快。

## 触发门槛（重要）

`workflow_run` 一次可能拉起数十个 codex 子进程。**只有用户明确表达了编排意图时才调用**：

- 用户说了「workflow」「并行 agent」「fan out」「orchestrate」「ultracode」等；
- 用户点名要跑某个命名 workflow；
- 用户所在的 skill / slash command 指示要调用它。

仅仅是「这个任务如果并行会更快」**不构成**调用理由。这种情况下先用一两句说明
可以开 workflow、大致成本，再问用户要不要开。

## 工作方式

先侦察，再编排。典型姿势是**混合式**：自己先用 grep/read 摸清工作清单
（哪些文件、哪些模块、diff 范围），拿到清单后再用 `workflow_run` 对清单做流水线。
你不需要在动手前就知道全貌，只需要在**下达编排指令前**知道。

使用本插件的 `dynamic-workflow` MCP server（单数），不要与其他同名或近似插件混用。调用 `workflow_run` 必须传入目标项目的绝对路径 `cwd`；MCP server 自身的目录是插件安装目录。列出项目自定义 workflow 时，`workflow_list` 也传入同一 `cwd`。

写完脚本先调 `workflow_validate`（不花钱），通过后再 `workflow_run`。

## 脚本骨架

```js
export const meta = {
  name: 'review-changes',
  description: '分维度审查改动，并对每条发现做对抗式验证',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: '审查 git diff，找出逻辑缺陷…' },
  { key: 'perf', prompt: '审查 git diff，找出性能问题…' },
]

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
          summary: { type: 'string' },
        },
      },
    },
  },
}

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  (review) =>
    parallel(
      (review?.findings ?? []).map((f) => () =>
        agent(`请尝试证伪这条发现：${f.summary}（${f.file}:${f.line}）。不确定时默认判为不成立。`, {
          label: `verify:${f.file}`,
          phase: 'Verify',
          schema: { type: 'object', properties: { real: { type: 'boolean' }, why: { type: 'string' } } },
        }).then((v) => ({ ...f, verdict: v })),
      ),
    ),
)

return { confirmed: results.flat().filter(Boolean).filter((f) => f.verdict?.real) }
```

## 可用钩子

| 钩子 | 说明 |
| --- | --- |
| `agent(prompt, opts?)` | 派发子 agent。有 `schema` 返回对象，否则返回字符串。在 `parallel`/`pipeline` 内失败降级为 `null` |
| `parallel(thunks)` | **屏障**：等齐全部。单分支失败为 `null`，记得 `.filter(Boolean)` |
| `pipeline(items, ...stages)` | **无屏障**流水线，默认首选。stage 签名 `(prev, originalItem, index)` |
| `phase(title)` / `log(msg)` | 进度分组与叙述 |
| `args` | 调用方传入的参数，原样透传 |
| `budget` | `{total, spent(), remaining()}`，`total` 为 `null` 表示不限 |
| `workflow(nameOrRef, args)` | 内联子 workflow，只允许一层嵌套 |

`agent` 的 opts：`label` `phase` `schema` `model` `effort` `sandbox` `agentType`
`isolation:'worktree'` `worktreeKey` `timeoutMs` `cwd`。

多阶段流程（如「改造 → 验证」）若要让后一阶段看到前一阶段的实际改动，两个 agent 必须
带**相同的 `worktreeKey`**；否则后一阶段会回到主工作区，读到未修改的旧文件。

## 默认用 pipeline，不要用 parallel

`parallel` 是屏障，会等最慢的那个。只有当下一阶段**确实需要上一阶段的全部结果**
（跨条目去重、总数为 0 时提前退出、prompt 里要引用「其他发现」）才用它。

「我得先 flatten 一下再进下一步」不是理由——把 transform 放进 pipeline 的某个 stage 里就行。

## 质量模式

按任务挑，也可以自由组合：

- **对抗式验证**：每条发现派 N 个独立「证伪者」，多数判否即丢弃。
- **视角分化验证**：给每个验证者不同镜头（正确性 / 安全 / 性能 / 能否复现），比 N 个同质验证者更能覆盖失败模式。
- **Judge panel**：从不同角度生成 N 个方案，并行打分，按赢家综合、并嫁接亚军的亮点。
- **跑到枯竭**：发现类任务（找 bug、找边界）循环到连续 K 轮无新增为止。去重要对「所有见过的」去重，不是对「已确认的」，否则永远收敛不了。
- **多模态扫描**：多个 agent 用不同检索角度（按容器 / 按内容 / 按实体 / 按时间）并行找。
- **完备性批判者**：最后派一个 agent 专门问「还缺什么——哪种检索没跑、哪条断言没验、哪个来源没读」。
- **不许静默截断**：如果脚本做了 top-N、抽样、不重试，必须 `log()` 出来，否则读者会以为覆盖全了。

## 规模

按用户的要求定档。「随便看看有没有 bug」→ 少量 finder、单票验证。
「彻底审一遍」「要全面」→ 更大的 finder 池、3–5 票对抗验证、加一个综合阶段。
拿不准时：调研/审查/审计类偏向彻底，快速确认类偏向精简。

## 限制

- 脚本是 JS，**不是 TS**：类型标注会直接语法报错。
- 禁用 `Date.now()` / `new Date()` / `Math.random()`（破坏 resume 的确定性）。需要时间戳就通过 `args` 传入。
- 脚本跑在独立 vm context 中，只有 JS 语言内建能力。无 `fetch`、无 `process`（也读不到环境变量）、无 `require`、无 `setTimeout`、不能 import 模块 —— I/O 都交给子 agent 去做。
- 单次 `parallel`/`pipeline` 最多 4096 项，单次 run 最多 1000 个 agent。
- 并发上限默认 `min(16, cpu-2)`，超出的排队。

## 断点续跑

每次 run 都会把脚本存档并返回 `runId` 与 `transcriptDir`。改完脚本后用
`workflow_run({ cwd, scriptPath, resumeFromRunId })` 续跑：**未变更的调用前缀**直接复用缓存，
从第一个改动过的调用开始重跑。

排查「为什么结果是空的」时，先用 `workflow_inspect` 看 journal 里每个 agent 的真实返回值，
不要凭空猜测。

预算是停止派发阈值，已运行请求可能超额；模拟运行不复用到真实运行，worktree 调用从该位置开始重跑。
