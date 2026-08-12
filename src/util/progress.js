/**
 * 终端进度渲染：把引擎事件流渲染成按 phase 分组的树形视图。
 *
 * 非 TTY（CI、被 MCP 调用）时降级为逐行 JSONL/文本输出，不做光标控制。
 */

const SYMBOLS = {
  running: '◐',
  ok: '✔',
  failed: '✘',
  cached: '⟲',
};

const COLORS = {
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
  reset: '[0m',
};

export class ProgressReporter {
  #stream;
  #tty;
  #color;
  #phases = new Map();
  #agents = new Map();
  #logs = [];
  #linesDrawn = 0;
  #startedAt = Date.now();
  #timer = null;

  constructor({ stream = process.stderr, tty = stream.isTTY, color = stream.isTTY } = {}) {
    this.#stream = stream;
    this.#tty = Boolean(tty);
    this.#color = Boolean(color);
  }

  start() {
    if (this.#tty) this.#timer = setInterval(() => this.#render(), 400).unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#tty) this.#render();
  }

  handle(event) {
    switch (event.type) {
      case 'run.started':
        this.#write(
          `${this.#c('cyan', '▶')} workflow ${this.#c('cyan', event.workflow)} — ${event.meta?.description ?? ''}`,
        );
        this.#write(
          this.#c('dim', `  run ${event.runId} · 并发 ${event.concurrency}${event.budget ? ` · 预算 ${event.budget} output tokens` : ''}`),
        );
        break;
      case 'phase.started':
        this.#ensurePhase(event.title);
        if (!this.#tty) this.#write(`${this.#c('cyan', '▸')} ${event.title}`);
        break;
      case 'log':
        this.#logs.push(event.message);
        if (!this.#tty) this.#write(this.#c('dim', `  · ${event.message}`));
        break;
      case 'agent.started':
        this.#agents.set(event.agentId, {
          label: event.label,
          phase: event.phase,
          status: 'running',
          startedAt: Date.now(),
        });
        this.#ensurePhase(event.phase);
        if (!this.#tty) this.#write(`  ${SYMBOLS.running} ${event.label}`);
        break;
      case 'agent.cached':
        this.#ensurePhase(event.phase);
        this.#agents.set(`cached-${event.seq}`, {
          label: event.label,
          phase: event.phase,
          status: 'cached',
        });
        if (!this.#tty) this.#write(`  ${SYMBOLS.cached} ${event.label} ${this.#c('dim', '(缓存命中)')}`);
        break;
      case 'agent.completed': {
        const entry = this.#agents.get(event.agentId);
        if (entry) {
          entry.status = 'ok';
          entry.durationMs = event.durationMs;
          entry.tokens = event.usage?.outputTokens ?? 0;
        }
        if (!this.#tty) {
          this.#write(
            `  ${this.#c('green', SYMBOLS.ok)} ${event.label} ${this.#c('dim', `${fmtMs(event.durationMs)} · ${event.usage?.outputTokens ?? 0} out`)}`,
          );
        }
        break;
      }
      case 'agent.retry':
        if (!this.#tty) {
          this.#write(
            this.#c('yellow', `  ↻ ${event.label} 第 ${event.attempt}/${event.maxAttempts} 次重试：${event.message}`),
          );
        }
        break;
      case 'agent.failed': {
        const entry = this.#agents.get(event.agentId);
        if (entry) entry.status = 'failed';
        if (!this.#tty) this.#write(this.#c('red', `  ${SYMBOLS.failed} ${event.label}: ${event.message}`));
        break;
      }
      case 'branch.failed':
      case 'item.dropped':
        if (!this.#tty) this.#write(this.#c('yellow', `  ! ${event.type} #${event.index}: ${event.message}`));
        break;
      case 'warning':
        this.#write(this.#c('yellow', `  ! ${event.message}`));
        break;
      case 'run.resume':
        this.#write(this.#c('dim', `  ⟲ 从 ${event.from} 恢复，可复用 ${event.cachedCalls} 次调用`));
        break;
      case 'run.finished':
        this.stop();
        this.#summary(event);
        break;
      default:
        break;
    }
  }

  #summary(event) {
    const ok = event.status === 'ok';
    const mark = ok ? this.#c('green', SYMBOLS.ok) : this.#c('red', SYMBOLS.failed);
    this.#write(
      `${mark} ${event.workflow} ${ok ? '完成' : event.status} · ${event.agentCount} agents · ${fmtMs(event.durationMs)}`,
    );
    const u = event.usage ?? {};
    this.#write(
      this.#c(
        'dim',
        `  tokens: in ${u.inputTokens ?? 0}（缓存 ${u.cachedInputTokens ?? 0}）· out ${u.outputTokens ?? 0}（推理 ${u.reasoningOutputTokens ?? 0}）`,
      ),
    );
    this.#write(this.#c('dim', `  产物: ${event.transcriptDir}`));
    if (event.error) this.#write(this.#c('red', `  错误: ${event.error.message}`));
  }

  #ensurePhase(title) {
    const key = title ?? '(未分组)';
    if (!this.#phases.has(key)) this.#phases.set(key, true);
  }

  /** TTY 下重绘整棵树 */
  #render() {
    if (!this.#tty) return;
    const lines = [];
    for (const phase of this.#phases.keys()) {
      const agents = [...this.#agents.values()].filter((a) => (a.phase ?? '(未分组)') === phase);
      const done = agents.filter((a) => a.status === 'ok' || a.status === 'cached').length;
      lines.push(`${this.#c('cyan', '▸')} ${phase} ${this.#c('dim', `(${done}/${agents.length})`)}`);
      for (const a of agents.slice(-12)) {
        const symbol =
          a.status === 'ok'
            ? this.#c('green', SYMBOLS.ok)
            : a.status === 'failed'
              ? this.#c('red', SYMBOLS.failed)
              : a.status === 'cached'
                ? this.#c('dim', SYMBOLS.cached)
                : SYMBOLS.running;
        const detail =
          a.status === 'running' && a.startedAt
            ? this.#c('dim', ` ${fmtMs(Date.now() - a.startedAt)}`)
            : a.durationMs
              ? this.#c('dim', ` ${fmtMs(a.durationMs)}`)
              : '';
        lines.push(`  ${symbol} ${a.label}${detail}`);
      }
    }
    for (const msg of this.#logs.slice(-3)) lines.push(this.#c('dim', `  · ${msg}`));

    this.#clear();
    this.#stream.write(`${lines.join('\n')}\n`);
    this.#linesDrawn = lines.length;
  }

  #clear() {
    if (!this.#tty || this.#linesDrawn === 0) return;
    this.#stream.write(`[${this.#linesDrawn}A[0J`);
    this.#linesDrawn = 0;
  }

  #write(line) {
    this.#clear();
    this.#stream.write(`${line}\n`);
  }

  #c(color, text) {
    if (!this.#color) return text;
    return `${COLORS[color] ?? ''}${text}${COLORS.reset}`;
  }
}

function fmtMs(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
