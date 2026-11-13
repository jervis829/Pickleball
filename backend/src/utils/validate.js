'use strict';
const { HttpError } = require('./response');

const TYPES = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  integer: v => Number.isInteger(v),
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
  json: v => v !== undefined,
  date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
};

function coerce(v, type) {
  if (type === 'integer' || type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (type === 'boolean') return v === true || v === 'true' || v === 1 || v === '1';
  return v;
}

/**
 * 在系统边界做输入校验。schema: { field: 'type' | {type, required, enum, min, max, maxLength, default, transform} }
 * partial=true 时跳过 required 检查（PATCH 用）。
 */
function validate(input, schema, opts = {}) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const out = {};
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const r = typeof rule === 'string' ? { type: rule } : rule;
    let v = src[field];
    if (v === undefined || v === null || v === '') {
      if (r.default !== undefined) v = r.default;
      else if (r.required && !opts.partial) { errors.push({ field, message: '必填项' }); continue; }
      else { if (opts.partial && v === undefined) continue; out[field] = v; continue; }
    }
    v = coerce(v, r.type);
    if (r.type !== 'json' && TYPES[r.type] && !TYPES[r.type](v)) {
      errors.push({ field, message: `类型应为 ${r.type}` }); continue;
    }
    if (r.enum && !r.enum.includes(v)) {
      errors.push({ field, message: `仅允许：${r.enum.join(' / ')}` }); continue;
    }
    if (typeof v === 'string' && r.maxLength && v.length > r.maxLength) {
      errors.push({ field, message: `长度不得超过 ${r.maxLength} 字符` }); continue;
    }
    if (typeof v === 'number') {
      if (r.min !== undefined && v < r.min) { errors.push({ field, message: `不得小于 ${r.min}` }); continue; }
      if (r.max !== undefined && v > r.max) { errors.push({ field, message: `不得大于 ${r.max}` }); continue; }
    }
    out[field] = r.transform ? r.transform(v) : v;
  }
  if (errors.length) throw new HttpError(422, 'VALIDATION_ERROR', '输入校验失败', errors);
  return out;
}

function parsePaging(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize, keyword: String(query.keyword || '').trim() };
}

module.exports = { validate, parsePaging, TYPES };
