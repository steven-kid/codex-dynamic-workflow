/**
 * 计数信号量：整个 run 共享一个实例，父子 workflow 也共享，
 * 这样嵌套 workflow 不会突破全局并发上限。
 */
export class Semaphore {
  #limit;
  #active = 0;
  #queue = [];

  constructor(limit) {
    const value = Math.floor(Number(limit));
    if (!Number.isFinite(value) || value < 1) {
      // NaN 会让 `active < limit` 恒为 false，首个 acquire 永久挂起且无人能释放
      throw new TypeError(`Semaphore 的并发上限必须是 ≥1 的有限整数，实际收到 ${limit}`);
    }
    this.#limit = value;
  }

  get limit() {
    return this.#limit;
  }

  get active() {
    return this.#active;
  }

  get pending() {
    return this.#queue.length;
  }

  /** 获取一个槽位，返回释放函数 */
  async acquire(signal) {
    if (signal?.aborted) throw signal.reason;
    if (this.#active < this.#limit) {
      this.#active += 1;
      return () => this.#release();
    }
    await new Promise((resolve, reject) => {
      const entry = {
        resolve: () => { signal?.removeEventListener('abort', abort); resolve(); },
      };
      const abort = () => {
        this.#queue.splice(this.#queue.indexOf(entry), 1);
        reject(signal.reason);
      };
      this.#queue.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
    });
    return () => this.#release();
  }

  /** 包裹一次异步调用，保证异常路径也会释放槽位 */
  async run(fn, signal) {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #release() {
    const next = this.#queue.shift();
    if (next) next.resolve(); // Transfer the reserved slot before another acquire.
    else this.#active -= 1;
  }
}
