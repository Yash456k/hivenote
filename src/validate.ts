import { HiveNoteError } from './contract.js';

/** Checks on everything that enters the store. Each returns the clean value or throws a validation_error. */

export const LIMITS = {
  name: 256,
  description: 4096,
  content: 524288,
  metadata: 32768,
  jsonDepth: 20,
  label: 256,
} as const;

export const STATUSES = ['todo', 'doing', 'done', 'cancelled'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function invalid(message: string): never {
  throw new HiveNoteError('validation_error', message);
}

/** A string of well-formed UTF-8, without NUL, within a byte limit; blank only when allowed. */
export function text(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  const ok = typeof value === 'string'
    && (allowEmpty || value.trim() !== '')
    && !LONE_SURROGATE.test(value)
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= maxBytes;
  if (!ok) invalid(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} well-formed UTF-8 string of at most ${maxBytes} bytes, without NUL`);
  return value as string;
}

export function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function id(value: unknown): string {
  const candidate = text(value, 'id', 36);
  if (!UUID.test(candidate)) invalid('id must be a UUID');
  return candidate;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Plain JSON only, with sorted keys. Sorting makes equal requests serialize equally,
 * which is how retried operations are recognized.
 */
export function json(value: unknown, depth = 0): unknown {
  if (depth > LIMITS.jsonDepth) invalid(`JSON nesting exceeds ${LIMITS.jsonDepth} levels`);
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) invalid('JSON strings must contain well-formed Unicode');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (isPlainObject(value)) {
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      if (LONE_SURROGATE.test(key)) invalid('JSON keys must contain well-formed Unicode');
      result[key] = json(value[key], depth + 1);
    }
    return result;
  }
  return invalid('Values must be JSON (no undefined, functions, cycles, or nonfinite numbers)');
}

export function metadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('metadata must be a JSON object');
  const serialized = JSON.stringify(json(value));
  if (Buffer.byteLength(serialized) > LIMITS.metadata) invalid(`metadata exceeds ${LIMITS.metadata} bytes`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

/** A UTC ISO timestamp that is a real calendar date (no February 30), or null to clear it. */
export function due(value: unknown): string | null {
  if (value === null) return null;
  const candidate = text(value, 'due_at', 40);
  if (!UTC_TIMESTAMP.test(candidate) || !Number.isFinite(Date.parse(candidate))) invalid('due_at must be a UTC ISO timestamp (or null)');
  const normalized = new Date(candidate).toISOString();
  if (normalized.slice(0, 19) !== candidate.slice(0, 19)) invalid('due_at contains an invalid calendar date');
  return normalized;
}

export function status(value: unknown): typeof STATUSES[number] {
  if (!STATUSES.includes(value as typeof STATUSES[number])) invalid('Invalid task status');
  return value as typeof STATUSES[number];
}

export function params(value: unknown, allowed: readonly string[], method: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid('params must be a JSON object');
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`Unknown parameter for ${method}`);
  return value;
}
