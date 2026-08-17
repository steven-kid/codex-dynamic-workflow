#!/usr/bin/env node
/**
 * cdw —— Codex Dynamic Workflow 命令行入口。
 *
 *   cdw run <script.js> [--args '<json>'] [--budget N] [--concurrency N] [--dry-run]
 *   cdw run --name <workflow-name>
 *   cdw list
 *   cdw show <name>
 *   cdw runs [--limit N]
 *   cdw resume <runId> --script <path>
 *   cdw validate <script.js>
 *   cdw mcp            # 以 MCP stdio server 方式运行
 */

import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
