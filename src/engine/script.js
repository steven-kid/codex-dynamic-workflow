/**
 * 脚本加载与 meta 校验。
 *
 * workflow 脚本是「带 export const meta 的 JS 模块体」，执行时会被包进一个
 * async function，注入 agent/parallel/pipeline/phase/log/args/budget/workflow 等全局钩子。
 *
 * meta 必须是纯字面量（不含变量、函数调用、模板插值），
 * 这样才能在不执行脚本的前提下静态读出 name/description/phases，
 * 用于列表展示与权限确认。
 */

import vm from 'node:vm';

import { WorkflowScriptError } from './errors.js';

const META_START_RE = /export\s+const\s+meta\s*=\s*\{/;

/**
 * 定位 meta 字面量的起止。用花括号配对扫描而不是正则，
 * 这样单行 meta、嵌套对象、以及 `}` 不在行首的写法都能正确处理。
 */
function locateMeta(source) {
  const start = source.match(META_START_RE);
  if (!start) return null;

  const braceStart = start.index + start[0].length - 1;
  let depth = 0;
  let inString = null;

  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // 连同后面的分号与换行一起吃掉，避免残留空语句
        let end = i + 1;
        if (source[end] === ';') end += 1;
        return { literal: source.slice(braceStart, i + 1), start: start.index, end };
      }
    }
  }
  return null;
}

/**
 * 不执行脚本，静态解析出 meta。
 * 用受限的 vm context 求值字面量，避免 eval 到任意代码。
 */
export function parseMeta(source) {
  const located = locateMeta(source);
  if (!located) {
    throw new WorkflowScriptError(
      '脚本必须以 `export const meta = { name, description, phases }` 开头（纯字面量）',
    );
  }

  assertPureLiteral(located.literal);

  let meta;
  try {
    meta = vm.runInNewContext(`(${located.literal})`, Object.create(null), { timeout: 200 });
  } catch (err) {
    throw new WorkflowScriptError(`meta 解析失败：${err.message}`);
  }

  validateMeta(meta);
  return {
    meta,
    metaSource: source.slice(located.start, located.end),
    // 用等长的换行占位，保证脚本体的行号与原文件一致，报错时行号才对得上
    body:
      source.slice(0, located.start).replace(/[^\n]/g, '') +
      source.slice(located.start, located.end).replace(/[^\n]/g, '') +
      source.slice(located.end),
  };
}

/** meta 里出现函数调用/模板插值/展开语法时直接拒绝 */
function assertPureLiteral(literal) {
  const banned = [
    [/`/, '模板字符串'],
    [/\.\.\./, '展开语法'],
    [/=>/, '箭头函数'],
    [/\bfunction\b/, '函数声明'],
    [/\brequire\s*\(/, 'require 调用'],
    [/\w\s*\(/, '函数调用'],
  ];
  for (const [re, label] of banned) {
    if (re.test(literal)) {
      throw new WorkflowScriptError(`meta 必须是纯字面量，检测到${label}`);
    }
  }
}

export function validateMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new WorkflowScriptError('meta 必须是对象字面量');
  }
  if (typeof meta.name !== 'string' || !meta.name.trim()) {
    throw new WorkflowScriptError('meta.name 必填，且必须是非空字符串');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.name)) {
    throw new WorkflowScriptError(`meta.name "${meta.name}" 必须是 kebab-case`);
  }
  if (typeof meta.description !== 'string' || !meta.description.trim()) {
    throw new WorkflowScriptError('meta.description 必填，用于权限确认时展示');
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new WorkflowScriptError('meta.phases 必须是数组');
    for (const [i, phase] of meta.phases.entries()) {
      if (!phase || typeof phase.title !== 'string' || !phase.title.trim()) {
        throw new WorkflowScriptError(`meta.phases[${i}].title 必填`);
      }
    }
  }
  return meta;
}

/**
 * 把脚本体编译成可执行函数。
 * 注入的钩子以形参方式传入，脚本体在 async function 内运行，可直接 await。
 */
export function compileScript(source, { filename = 'workflow.js' } = {}) {
  const { meta, body } = parseMeta(source);

  const hookNames = [
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    'budget',
    'workflow',
    'meta',
  ];

  // 禁止脚本使用会破坏 resume 确定性的 API
  const wrapped = `
return (async function workflowBody(${hookNames.join(', ')}) {
  const Date = new Proxy(globalThis.Date, {
    construct(target, argv) {
      if (argv.length === 0) throw new Error('workflow 脚本禁止使用 new Date()：会破坏 resume 确定性，请通过 args 传入时间戳');
      return Reflect.construct(target, argv);
    },
    get(target, prop, receiver) {
      if (prop === 'now') throw new Error('workflow 脚本禁止使用 Date.now()：会破坏 resume 确定性，请通过 args 传入时间戳');
      return Reflect.get(target, prop, receiver);
    },
  });
  const Math = new Proxy(globalThis.Math, {
    get(target, prop, receiver) {
      if (prop === 'random') throw new Error('workflow 脚本禁止使用 Math.random()：会破坏 resume 确定性，请用 index 或 label 制造差异');
      return Reflect.get(target, prop, receiver);
    },
  });
${body}
});
`;

  let factory;
  try {
    factory = vm.compileFunction(wrapped, [], { filename });
  } catch (err) {
    throw new WorkflowScriptError(`脚本语法错误：${err.message}`, { cause: err });
  }

  let run;
  try {
    run = factory();
  } catch (err) {
    throw new WorkflowScriptError(`脚本初始化失败：${err.message}`, { cause: err });
  }

  return { meta, run };
}
