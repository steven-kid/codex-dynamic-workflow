import { WorkflowAbortError } from './errors.js';

/** Live controls. Pause stops dispatch, allowing in-flight calls to finish. */
export class RunControl {
  constructor() {
    this.controller = new AbortController();
    this.paused = false;
    this.agents = new Map();
    this.waiters = new Set();
  }

  get signal() { return this.controller.signal; }

  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    for (const wake of this.waiters) wake();
  }
  cancel(agentId) {
    if (agentId !== undefined) {
      const agent = this.agents.get(agentId);
      if (!agent) throw new Error(`agent 不在运行或队列中: ${agentId}`);
      agent.abort();
    } else {
      this.controller.abort();
      this.resume();
    }
  }

  async wait(signal) {
    if (signal?.aborted) throw new WorkflowAbortError('run 或 agent 已中止');
    if (!this.paused) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', abort);
      };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new WorkflowAbortError('run 或 agent 已中止')); };
      this.waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
