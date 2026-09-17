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
import { MAX_ITEMS_PER_CALL } from './constants.js';

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
 * 脚本在独立 vm context 的 async function 内运行，可直接 await。
 * 宿主钩子只经 JSON bridge 调用，不能直接把宿主函数/对象注入脚本 realm。
 */
export function compileScript(source, { filename = 'workflow.js' } = {}) {
  const { meta, body } = parseMeta(source);
  // Node may reject import() with a host-realm Error before invoking a custom
  // loader. Reject it at validation time so that object never reaches the VM.
  // This conservative check also rejects import() text in literals/comments.
  if (/\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/.test(body)) {
    throw new WorkflowScriptError('workflow 脚本不支持 import()；需要模块的操作请交给 agent');
  }

  // Only JSON strings cross the context boundary. Never expose host functions,
  // promises, errors or result objects to workflow code (constructor escapes).
  try {
    new vm.Script(`(async function() {${body}\n})`, { filename });
  } catch (err) {
    throw new WorkflowScriptError(`脚本语法错误：${err.message}`, { cause: err });
  }

  const run = async (hooks = {}) => {
    const invoke = async (name, encoded) => {
      try {
        const value = await hooks[name](...JSON.parse(encoded));
        return JSON.stringify({ value });
      } catch (err) {
        return JSON.stringify({ error: { name: err.name, message: err.message } });
      }
    };
    const sync = (name, encoded) => {
      try {
        const value = name === 'budget'
          ? { total: hooks.budget?.total ?? null, spent: hooks.budget?.spent() ?? 0 }
          : hooks[name](...JSON.parse(encoded));
        return JSON.stringify({ value });
      } catch (err) {
        return JSON.stringify({ error: { name: err.name, message: err.message } });
      }
    };
    const context = vm.createContext(Object.assign(Object.create(null), {
      __invoke: invoke, __sync: sync,
      __data: JSON.stringify({ args: hooks.args, meta }),
    }), { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(`
      ((invoke, sync, data) => {
        delete globalThis.__invoke; delete globalThis.__sync; delete globalThis.__data;
        const decode = text => {
          const packet = JSON.parse(text);
          if (packet.error) {
            const error = new Error(packet.error.message);
            error.name = packet.error.name;
            throw error;
          }
          return packet.value;
        };
        const fail = (message, name = 'WorkflowScriptError') => { const e = new Error(message); e.name = name; throw e; };
        const fatal = e => ['WorkflowAbortError', 'BudgetExhaustedError', 'WorkflowLimitError', 'WorkflowScriptError'].includes(e?.name);
        const check = items => {
          if (!Array.isArray(items)) fail('parallel/pipeline 需要一个数组');
          if (items.length > ${MAX_ITEMS_PER_CALL}) fail('parallel/pipeline 最多接受 ${MAX_ITEMS_PER_CALL} 个条目', 'WorkflowLimitError');
        };
        const guarded = async (fn, event) => {
          try { return await fn(); }
          catch (e) { if (fatal(e)) throw e; decode(sync('reportFailure', JSON.stringify([{ ...event, message: e.message }]))); return null; }
        };
        for (const name of ['agent', 'workflow']) {
          globalThis[name] = async (...values) => decode(await invoke(name, JSON.stringify(values)));
        }
        for (const name of ['phase', 'log']) {
          globalThis[name] = (...values) => decode(sync(name, JSON.stringify(values)));
        }
        globalThis.parallel = async thunks => {
          check(thunks);
          if (thunks.some(t => typeof t !== 'function')) fail('parallel 需要函数数组');
          return Promise.all(thunks.map((t, index) => guarded(t, { type: 'branch.failed', index })));
        };
        globalThis.pipeline = async (items, ...stages) => {
          check(items);
          if (stages.some(s => typeof s !== 'function')) fail('pipeline stage 必须是函数');
          return Promise.all(items.map((item, index) => guarded(async () => {
            let value = item;
            for (const stage of stages) value = await stage(value, item, index);
            return value;
          }, { type: 'item.dropped', index })));
        };
        globalThis.budget = Object.freeze({
          get total() { return decode(sync('budget', '[]')).total; },
          spent: () => decode(sync('budget', '[]')).spent,
          remaining: () => { const b = decode(sync('budget', '[]')); return b.total === null ? Infinity : Math.max(0, b.total - b.spent); },
        });
        globalThis.args = undefined;
        Object.assign(globalThis, JSON.parse(data));
        const NativeDate = Date;
        const deniedDate = () => { throw new Error('workflow 脚本禁止使用 Date.now()/new Date()/Date()'); };
        function FixedDate(...values) {
          if (!new.target || !values.length) deniedDate();
          return Reflect.construct(NativeDate, values, FixedDate);
        }
        FixedDate.prototype = NativeDate.prototype;
        FixedDate.now = deniedDate;
        FixedDate.parse = NativeDate.parse; FixedDate.UTC = NativeDate.UTC;
        Object.setPrototypeOf(FixedDate, Function.prototype);
        Object.defineProperty(NativeDate.prototype, 'constructor', { value: FixedDate });
        NativeDate.now = deniedDate;
        globalThis.Date = new Proxy(FixedDate, { apply: deniedDate });
        Object.defineProperty(Math, 'random', { value: () => { throw new Error('workflow 脚本禁止使用 Math.random()'); }, writable: false, configurable: false });
      })(__invoke, __sync, __data);
    `).runInContext(context, { timeout: 1000 });
    try {
      // The body is compiled separately, so it cannot capture the private bridge.
      const result = await new vm.Script(`(async () => {${body}\n})()`, { filename })
        .runInContext(context, { timeout: 1000 });
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    } catch (err) {
      // Restore engine error identity after crossing realms.
      const errors = await import('./errors.js');
      const Type = errors[err.name] ?? Error;
      throw new Type(err.message);
    }
  };
  return { meta, run };
}
