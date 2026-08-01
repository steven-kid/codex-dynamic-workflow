/**
 * 结构化输出支持。
 *
 * Codex 的 `--output-schema` 走 OpenAI Structured Outputs 严格模式，
 * 服务端要求：根为 object、每个 object 都要 additionalProperties:false、
 * required 必须列全所有 properties。用户手写 schema 时几乎必踩坑，
 * 所以这里做一次自动规范化（normalizeSchema），再落盘给 codex。
 *
 * 另外 codex 会把 schema 施加到 turn 内**每一条** agent_message 上
 * （openai/codex#19816），所以取结果时必须取最后一条 agent_message，
 * 这个约束在 codex.js 的事件解析里落实。
 */

import { WorkflowScriptError } from './errors.js';

/**
 * 递归规范化 JSON Schema 以满足 strict 模式。
 * 不改变语义，只补齐 strict 模式强制的字段。
 */
export function normalizeSchema(schema, path = '$') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new WorkflowScriptError(`schema ${path} 必须是对象`);
  }

  const out = { ...schema };

  for (const key of ['$defs', 'definitions']) {
    if (out[key] && typeof out[key] === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([name, sub]) => [
          name,
          normalizeSchema(sub, `${path}.${key}.${name}`),
        ]),
      );
    }
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(out[key])) {
      out[key] = out[key].map((sub, i) => normalizeSchema(sub, `${path}.${key}[${i}]`));
    }
  }

  if (isObjectSchema(out)) {
    const properties = out.properties ?? {};
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, sub]) => [
        name,
        normalizeSchema(sub, `${path}.${name}`),
      ]),
    );
    // strict 模式：所有 property 必须出现在 required 里；
    // 要表达「可选」请用 nullable（type: ["string","null"]）。
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }

  if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) {
    out.items = normalizeSchema(out.items, `${path}[]`);
  }

  return out;
}

function isObjectSchema(schema) {
  if (schema.type === 'object') return true;
  if (Array.isArray(schema.type) && schema.type.includes('object')) return true;
  // 没写 type 但有 properties，按 object 处理
  return schema.type === undefined && schema.properties !== undefined;
}

/** 根 schema 必须是 object，这是 strict 模式的硬性要求 */
export function assertRootSchema(schema) {
  const normalized = normalizeSchema(schema);
  if (normalized.type !== 'object' && !Array.isArray(normalized.type)) {
    throw new WorkflowScriptError(
      'schema 根节点必须是 { "type": "object" }；如需返回数组，请包一层 { items: [...] }',
    );
  }
  return normalized;
}

/**
 * 从 agent 最终文本里抽出 JSON。
 * 模型偶尔会加 ```json 围栏或前后寒暄，这里做容错解析。
 */
export function extractJson(text) {
  if (typeof text !== 'string') return { ok: false, error: '输出为空' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '输出为空' };

  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* 试下一个候选 */
    }
  }
  return { ok: false, error: '无法从输出中解析出 JSON' };
}

/**
 * 轻量 schema 校验：只覆盖 strict 模式用得到的子集
 * （type / required / properties / items / enum / anyOf）。
 * 目的是在拿到结果后立刻发现「模型返回了错误形状」，触发一次纠正重试，
 * 而不是把脏数据交给下游 stage。
 */
export function validateAgainstSchema(value, schema, path = '$') {
  const errors = [];
  walk(value, schema, path, errors, schema);
  return { valid: errors.length === 0, errors };
}

function walk(value, schema, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved) walk(value, resolved, path, errors, root);
    return;
  }

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = schema.anyOf ?? schema.oneOf;
    const matched = branches.some((branch) => {
      const sub = [];
      walk(value, branch, path, sub, root);
      return sub.length === 0;
    });
    if (!matched) errors.push(`${path}: 不匹配任何 anyOf/oneOf 分支`);
    return;
  }

  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path}: 期望类型 ${types.join('|')}，实际 ${describe(value)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: 取值必须是 ${JSON.stringify(schema.enum)} 之一`);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: 缺失必填字段`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) walk(value[key], sub, `${path}.${key}`, errors, root);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors, root));
  }
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) return null;
  return ref
    .slice(2)
    .split('/')
    .reduce((acc, part) => (acc ? acc[decodeURIComponent(part)] : undefined), root);
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
