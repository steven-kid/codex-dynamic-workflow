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
  async acquire() {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return () => this.#release();
    }
    await new Promise((resolve) => this.#queue.push(resolve));
    this.#active += 1;
    return () => this.#release();
  }

  /** 包裹一次异步调用，保证异常路径也会释放槽位 */
  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #release() {
    this.#active -= 1;
    const next = this.#queue.shift();
    if (next) next();
  }
}
