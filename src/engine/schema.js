/** Preserve caller schema semantics; use strict transport only when already compatible. */
import { Ajv, Ajv2019, Ajv2020, addFormats } from '../vendor/validation.js';
import { WorkflowScriptError } from './errors.js';

const validators = [Ajv, Ajv2019, Ajv2020].map(Type => {
  const ajv = new Type({ allErrors: true, strict: false, validateFormats: true, addUsedSchema: false });
  addFormats(ajv);
  return ajv;
});
const cache = new WeakMap();
function validator(schema) {
  if (cache.has(schema)) return cache.get(schema);
  const draft = schema.$schema ?? '';
  const ajv = validators[draft.includes('2020-12') ? 2 : draft.includes('2019-09') ? 1 : 0];
  let validate;
  try { validate = ajv.compile(schema); ajv.removeSchema(schema); }
  catch (err) { throw new WorkflowScriptError(`无效的 JSON Schema：${err.message}`); }
  cache.set(schema, validate);
  return validate;
}

export function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new WorkflowScriptError('schema 必须是 JSON Schema 对象');
  }
  const out = JSON.parse(JSON.stringify(schema));
  assertPossible(out);
  validator(out);
  return out;
}

function assertPossible(node) {
  if (!node || typeof node !== 'object') return;
  if (node.additionalProperties === false) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(node.properties ?? {}, key) &&
          !Object.keys(node.patternProperties ?? {}).some(pattern => new RegExp(pattern).test(key))) {
        throw new WorkflowScriptError(`schema 必填字段 "${key}" 被 additionalProperties:false 禁止`);
      }
    }
  }
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties']) {
    for (const sub of Object.values(node[key] ?? {})) assertPossible(sub);
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) assertPossible(node[key]);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) (node[key] ?? []).forEach(assertPossible);
}

export function assertRootSchema(schema) {
  return normalizeSchema(schema);
}

// A conservative subset accepted by Codex structured outputs. Anything else
// uses prompted JSON + full local validation, never a rewritten schema.
export function strictOutputSchema(schema) {
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'title', 'anyOf', '$defs', '$ref']);
  const visit = node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (Object.keys(node).some(key => !supported.has(key))) return false;
    if (node.type === 'object' || node.properties || [].concat(node.type).includes('object')) {
      const props = Object.keys(node.properties ?? {});
      if (node.additionalProperties !== false || !Array.isArray(node.required) ||
          props.length !== node.required.length || props.some(key => !node.required.includes(key))) return false;
      if (!Object.values(node.properties ?? {}).every(visit)) return false;
    }
    if (node.items && !visit(node.items)) return false;
    if (node.anyOf && !node.anyOf.every(visit)) return false;
    if (node.$defs && !Object.values(node.$defs).every(visit)) return false;
    return true;
  };
  return schema?.type === 'object' && !schema.anyOf && visit(schema) ? schema : null;
}

export function validateAgainstSchema(value, schema) {
  const validate = validator(schema);
  const valid = validate(value);
  const errors = (validate.errors ?? []).map(e => `${e.instancePath || '$'}: ${e.message} ${JSON.stringify(e.params)}`);
  return { valid, errors };
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
