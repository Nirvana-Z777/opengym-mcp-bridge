import { PlanError } from './errors.mjs';

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function object(value, label = 'input') {
  if (!isObject(value)) throw new PlanError(`${label} must be an object`);
  return value;
}
export function only(value, keys, label = 'input') {
  object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new PlanError(`${label} contains unsupported fields`);
}
export function text(value, max, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > max) {
    throw new PlanError(`${label} must be ${empty ? '0' : '1'}-${max} characters`);
  }
  return value.trim();
}
export function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PlanError(`${label} must be a finite number from ${min} to ${max}`);
  }
  return value;
}
export function integer(value, min, max, label) {
  number(value, min, max, label);
  if (!Number.isInteger(value)) throw new PlanError(`${label} must be an integer`);
  return value;
}
export function date(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PlanError(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new PlanError(`${label} must be a valid date`);
  return value;
}
export function boolean(value, label) {
  if (typeof value !== 'boolean') throw new PlanError(`${label} must be a boolean`);
  return value;
}
export function boundedOutput(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new PlanError('Result exceeds 128 KiB; narrow the query or use the openGym app', 'response-too-large');
  return value;
}
