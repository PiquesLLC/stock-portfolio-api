// Unit tests for metadata canonicalization helpers used by the dedup
// intent-divergence check in postTransaction.
//
// Why this matters: when a Stripe webhook is retried and the second
// attempt's metadata differs from the first (e.g., Stripe added/removed
// a field), we MUST detect the divergence and surface CRITICAL — not
// silently ack as "already done." But equally important: when metadata
// is logically identical but represented differently (key order,
// Date vs ISO string, undefined keys), we MUST NOT false-positive a
// benign retry as divergence.
//
// These tests lock in:
//   - Date instances → ISO string (matching Postgres JSONB round-trip)
//   - undefined values → dropped symmetrically
//   - BigInt values → rejected up-front (would corrupt storage)
//   - NaN / Infinity → rejected (silently coerced to null by JSON)
//   - Cycles → rejected before recursive walker runs (stack-overflow guard)
//   - Key-order independence (canonical sort)

import { describe, expect, it } from 'vitest';
import { canonicalMetadata, stripSourceTag, validateMetadataIsJsonable } from '../post-transaction';

describe('canonicalMetadata (key-order independence)', () => {
  it('produces same string for differently-ordered objects', () => {
    expect(canonicalMetadata({ a: 1, b: 2 })).toBe(canonicalMetadata({ b: 2, a: 1 }));
  });

  it('produces same string for nested objects regardless of key order', () => {
    const a = { outer: { x: 1, y: 2 }, top: 'value' };
    const b = { top: 'value', outer: { y: 2, x: 1 } };
    expect(canonicalMetadata(a)).toBe(canonicalMetadata(b));
  });

  it('produces same string for arrays regardless of array element key order', () => {
    const a = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    const b = [{ y: 2, x: 1 }, { y: 4, x: 3 }];
    expect(canonicalMetadata(a)).toBe(canonicalMetadata(b));
  });

  it('treats array element ORDER as significant', () => {
    expect(canonicalMetadata([1, 2, 3])).not.toBe(canonicalMetadata([3, 2, 1]));
  });
});

describe('canonicalMetadata (Date handling)', () => {
  it('converts Date to ISO string (matching Postgres JSONB)', () => {
    const d = new Date('2026-05-28T12:34:56Z');
    expect(canonicalMetadata({ when: d })).toBe(canonicalMetadata({ when: d.toISOString() }));
  });

  it('distinguishes different Dates (the bug the audit caught)', () => {
    const a = canonicalMetadata({ when: new Date('2026-01-01T00:00:00Z') });
    const b = canonicalMetadata({ when: new Date('2026-12-31T00:00:00Z') });
    expect(a).not.toBe(b);
  });

  it('handles Date inside arrays', () => {
    const d1 = new Date('2026-01-01T00:00:00Z');
    const d2 = new Date('2026-12-31T00:00:00Z');
    expect(canonicalMetadata([d1, d2])).not.toBe(canonicalMetadata([d2, d1]));
  });
});

describe('canonicalMetadata (undefined handling)', () => {
  it('treats {x: undefined} as equivalent to {} (matching Postgres JSONB)', () => {
    expect(canonicalMetadata({ a: 1, b: undefined })).toBe(canonicalMetadata({ a: 1 }));
  });

  it('treats nested undefined as dropped', () => {
    expect(canonicalMetadata({ outer: { a: 1, b: undefined } })).toBe(
      canonicalMetadata({ outer: { a: 1 } })
    );
  });

  it('treats undefined input as null', () => {
    expect(canonicalMetadata(undefined)).toBe('null');
  });

  it('arrays with undefined elements normalize to null elements (JSON behavior)', () => {
    // JSON.stringify([undefined]) → '[null]' — symmetric with Postgres.
    expect(canonicalMetadata([1, undefined, 3])).toBe(canonicalMetadata([1, null, 3]));
  });
});

describe('canonicalMetadata (primitives)', () => {
  it('handles strings', () => {
    expect(canonicalMetadata({ s: 'hello' })).toBe('{"s":"hello"}');
  });

  it('handles numbers', () => {
    expect(canonicalMetadata({ n: 42 })).toBe('{"n":42}');
  });

  it('handles booleans', () => {
    expect(canonicalMetadata({ t: true, f: false })).toBe('{"f":false,"t":true}');
  });

  it('handles null', () => {
    expect(canonicalMetadata({ n: null })).toBe('{"n":null}');
  });

  it('handles deeply nested mixed types', () => {
    const v = {
      array: [1, { key: 'value', nested: [true, null] }],
      obj: { date: new Date('2026-01-01T00:00:00Z'), num: 3.14 },
    };
    const canon = canonicalMetadata(v);
    // Roundtrip stability: canonicalizing twice produces the same string.
    expect(canonicalMetadata(JSON.parse(JSON.stringify(v)))).toBe(canon);
  });
});

describe('validateMetadataIsJsonable (rejection of non-JSON values)', () => {
  it('accepts undefined metadata (caller may omit)', () => {
    expect(() => validateMetadataIsJsonable(undefined, 0)).not.toThrow();
  });

  it('accepts plain objects', () => {
    expect(() => validateMetadataIsJsonable({ a: 1, b: 'two' }, 0)).not.toThrow();
  });

  it('accepts arrays', () => {
    expect(() => validateMetadataIsJsonable([1, 2, 3], 0)).not.toThrow();
  });

  it('rejects BigInt values', () => {
    expect(() => validateMetadataIsJsonable({ amount: 100n }, 0))
      .toThrow(/not JSON-serializable/);
  });

  it('rejects BigInt nested in an array', () => {
    expect(() => validateMetadataIsJsonable({ amounts: [100n] }, 0))
      .toThrow(/not JSON-serializable/);
  });

  it('rejects circular references', () => {
    const obj: { self?: unknown } = {};
    obj.self = obj;
    expect(() => validateMetadataIsJsonable(obj, 0))
      .toThrow(/not JSON-serializable/);
  });

  it('rejects NaN', () => {
    expect(() => validateMetadataIsJsonable({ x: NaN }, 0))
      .toThrow(/non-finite number/);
  });

  it('rejects Infinity', () => {
    expect(() => validateMetadataIsJsonable({ x: Infinity }, 0))
      .toThrow(/non-finite number/);
  });

  it('rejects -Infinity', () => {
    expect(() => validateMetadataIsJsonable({ x: -Infinity }, 0))
      .toThrow(/non-finite number/);
  });

  it('rejects NaN nested deeply', () => {
    expect(() => validateMetadataIsJsonable({ outer: { inner: { x: NaN } } }, 0))
      .toThrow(/non-finite number/);
  });

  it('rejects NaN inside arrays', () => {
    expect(() => validateMetadataIsJsonable({ values: [1, NaN, 3] }, 0))
      .toThrow(/non-finite number/);
  });

  it('includes the entry index in error message', () => {
    expect(() => validateMetadataIsJsonable({ x: NaN }, 7))
      .toThrow(/Entry 7/);
  });

  it('includes the path-to-value in NaN errors for debugging', () => {
    expect(() => validateMetadataIsJsonable({ outer: { values: [1, NaN] } }, 0))
      .toThrow(/metadata\.outer\.values\[1\]/);
  });

  it('rejects function values (silently dropped by JSON.stringify)', () => {
    expect(() => validateMetadataIsJsonable({ callback: () => {} }, 0))
      .toThrow(/contains a function/);
  });

  it('rejects function values nested in objects', () => {
    expect(() => validateMetadataIsJsonable({ outer: { fn: function () {} } }, 0))
      .toThrow(/contains a function/);
  });

  it('rejects function values inside arrays', () => {
    expect(() => validateMetadataIsJsonable({ list: [() => {}] }, 0))
      .toThrow(/contains a function/);
  });

  it('rejects Symbol values (silently dropped by JSON.stringify)', () => {
    expect(() => validateMetadataIsJsonable({ tag: Symbol('x') }, 0))
      .toThrow(/contains a Symbol/);
  });

  it('rejects Symbol values inside arrays', () => {
    expect(() => validateMetadataIsJsonable({ tags: [Symbol('a')] }, 0))
      .toThrow(/contains a Symbol/);
  });

  it('rejects top-level BigInt (caller-facing API surface)', () => {
    // The type signature is `unknown` — defend against callers passing
    // primitives at the top level instead of an object.
    expect(() => validateMetadataIsJsonable(100n, 0))
      .toThrow(/not JSON-serializable/);
  });

  it('accepts top-level plain string (defensive)', () => {
    // Strings are a legitimate JSON value at the top level.
    expect(() => validateMetadataIsJsonable('plain', 0)).not.toThrow();
  });

  it('accepts top-level plain number (defensive)', () => {
    expect(() => validateMetadataIsJsonable(42, 0)).not.toThrow();
  });

  it('rejects top-level NaN (path is just root)', () => {
    expect(() => validateMetadataIsJsonable(NaN, 0)).toThrow(/non-finite number/);
  });
});

describe('stripSourceTag (writer-identity normalization for divergence check)', () => {
  it('returns null for null input', () => {
    expect(stripSourceTag(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(stripSourceTag(undefined)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(stripSourceTag({})).toBeNull();
  });

  it('returns null when only key was source', () => {
    expect(stripSourceTag({ source: 'v2-shadow-write' })).toBeNull();
  });

  it('strips source key from object with other fields', () => {
    expect(stripSourceTag({ source: 'v1-backfill', legacy_destination: true }))
      .toEqual({ legacy_destination: true });
  });

  it('passes through object with no source key', () => {
    expect(stripSourceTag({ legacy_destination: true })).toEqual({ legacy_destination: true });
  });

  it('passes arrays through unchanged', () => {
    expect(stripSourceTag([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('passes primitives through unchanged', () => {
    expect(stripSourceTag('plain')).toBe('plain');
    expect(stripSourceTag(42)).toBe(42);
  });

  it('CONVERGENCE TEST: shadow-write {source: ...} canonicalizes identically to MIG-1 null', () => {
    // The exact scenario from the BLOCK-1 reviewer finding.
    const shadowMeta = { source: 'v2-shadow-write' };
    const mig1Meta = null;
    expect(canonicalMetadata(stripSourceTag(shadowMeta)))
      .toBe(canonicalMetadata(stripSourceTag(mig1Meta)));
  });

  it('CONVERGENCE TEST: legacy_destination metadata matches across writers', () => {
    const shadowMeta = { legacy_destination: true, source: 'v2-shadow-write' };
    const mig1Meta = { legacy_destination: true, source: 'v1-backfill' };
    expect(canonicalMetadata(stripSourceTag(shadowMeta)))
      .toBe(canonicalMetadata(stripSourceTag(mig1Meta)));
  });

  it('DIVERGENCE TEST: real intent differences are still caught', () => {
    // A buggy caller writing different amounts/notes should still fail.
    const original = { note: 'first attempt', source: 'webhook' };
    const tampered = { note: 'second attempt', source: 'webhook' };
    expect(canonicalMetadata(stripSourceTag(original)))
      .not.toBe(canonicalMetadata(stripSourceTag(tampered)));
  });
});

describe('canonicalMetadata vs validateMetadataIsJsonable ordering', () => {
  it('validate must reject BigInt BEFORE canonicalMetadata is called', () => {
    // Documented: validateMetadataIsJsonable is called in the entry loop;
    // canonicalMetadata is called later in the dedup divergence check.
    // If a caller bypassed validation, canonicalMetadata's JSON.stringify
    // would throw — fail-loud, not silently corrupt.
    expect(() => canonicalMetadata({ amount: 100n })).toThrow();
  });
});
