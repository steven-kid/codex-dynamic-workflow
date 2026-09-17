/**
 * 极简 MCP stdio server 实现（JSON-RPC 2.0 over stdio，LSP 风格 Content-Length 帧 +
 * 换行分隔帧双兼容）。
 *
 * 不引 @modelcontextprotocol/sdk 是为了让插件零依赖：用户 clone 下来就能跑，
 * 不需要先 npm install。协议面只实现 Codex 实际会用到的部分：
 *   initialize / initialized / tools/list / tools/call / ping / shutdown
 */

import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = '2025-06-18';

export class McpServer {
  #tools = new Map();
  #requests = new Map();
  #closing = false;
  #name;
  #version;
  #stdin;
  #stdout;
  #buffer = Buffer.alloc(0);
  #useFraming = false;

  constructor({ name, version, stdin = process.stdin, stdout = process.stdout }) {
    this.#name = name;
    this.#version = version;
    this.#stdin = stdin;
    this.#stdout = stdout;
  }

  /**
   * @param {object} tool { name, description, inputSchema, handler }
   * handler(args, { sendProgress }) → { content:[...], isError?, structuredContent? }
   */
  registerTool(tool) {
    this.#tools.set(tool.name, tool);
  }

  listen() {
    this.#stdin.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    const close = () => {
      this.#closing = true;
      for (const controller of this.#requests.values()) controller.abort();
      this.#stdin.destroy();
    };
    this.#stdin.on('end', close);
    // Terminate active agents before the MCP process exits on host shutdown.
    if (this.#stdin === process.stdin) {
      process.once('SIGTERM', close);
      process.once('SIGINT', close);
    }
  }

  /** 同时支持 Content-Length 帧与逐行 JSON */
  #drain() {
    for (;;) {
      const text = this.#buffer.toString('utf8');
      const headerEnd = text.indexOf('\r\n\r\n');

      if (headerEnd !== -1 && /content-length:/i.test(text.slice(0, headerEnd))) {
        const header = text.slice(0, headerEnd);
        const match = header.match(/content-length:\s*(\d+)/i);
        if (!match) return;
        const length = Number(match[1]);
        const bodyStart = Buffer.byteLength(header, 'utf8') + 4;
        if (this.#buffer.length < bodyStart + length) return;
        const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
        this.#buffer = this.#buffer.subarray(bodyStart + length);
        this.#useFraming = true;
        this.#dispatchRaw(body);
        continue;
      }

      const newline = text.indexOf('\n');
      if (newline === -1) return;
      const line = text.slice(0, newline).trim();
      this.#buffer = Buffer.from(text.slice(newline + 1), 'utf8');
      if (line) this.#dispatchRaw(line);
    }
  }

  async #dispatchRaw(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // 忽略非法帧
    }
    try {
      await this.#handle(message);
    } catch (err) {
      if (message.id !== undefined) {
        this.#send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: err?.message ?? String(err) },
        });
      }
    }
  }

  async #handle(message) {
    const { id, method, params } = message;
    // 通知（无 id）不需要回包
    if (id === undefined) {
      if (method === 'notifications/cancelled') this.#requests.get(params?.requestId)?.abort();
      return;
    }

    switch (method) {
      case 'initialize':
        return this.#send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.#name, version: this.#version },
          },
        });

      case 'ping':
        return this.#send({ jsonrpc: '2.0', id, result: {} });

      case 'tools/list':
        return this.#send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...this.#tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: t.annotations,
            })),
          },
        });

      case 'tools/call': {
        const tool = this.#tools.get(params?.name);
        if (!tool) {
          return this.#send({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `未知工具: ${params?.name}` },
          });
        }
        const controller = new AbortController();
        this.#requests.set(id, controller);
        let progress = 0;
        try {
          const result = await tool.handler(params.arguments ?? {}, {
            signal: controller.signal,
            sendProgress: (text) => this.#notifyProgress(params?._meta?.progressToken, text, ++progress),
          });
          return this.#send({ jsonrpc: '2.0', id, result });
        } catch (err) {
          // 工具级错误按 MCP 约定放进 result.isError，让模型能看到并自行纠正
          return this.#send({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `工具执行失败: ${err?.message ?? err}` }],
            },
          });
        } finally {
          this.#requests.delete(id);
        }
      }

      case 'shutdown':
        this.#send({ jsonrpc: '2.0', id, result: {} });
        this.#closing = true;
        for (const controller of this.#requests.values()) controller.abort();
        this.#stdin.destroy();
        return undefined;

      default:
        return this.#send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `未实现的方法: ${method}` },
        });
    }
  }

  #notifyProgress(token, text, progress) {
    if (token === undefined || token === null) return;
    this.#send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress, message: text },
    });
  }

  #send(payload) {
    if (this.#closing) return;
    const json = JSON.stringify(payload);
    if (this.#useFraming) {
      this.#stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      this.#stdout.write(`${json}\n`);
    }
  }
}

/** 便捷构造：纯文本结果 */
export function textResult(text, extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}

export { createInterface };
