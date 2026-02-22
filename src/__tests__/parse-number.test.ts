import { describe, it, expect } from 'vitest';
import { parseNumber } from '../utils/parse-number';

describe('parseNumber', () => {
  it('parses standard dollar amounts', () => {
    expect(parseNumber('$1,234.56')).toBe(1234.56);
    expect(parseNumber('$100.00')).toBe(100);
    expect(parseNumber('$0.00')).toBe(0);
  });

  it('parses parenthetical negatives', () => {
    expect(parseNumber('(500.00)')).toBe(-500);
    expect(parseNumber('(1,234.56)')).toBe(-1234.56);
    expect(parseNumber('($1,234.56)')).toBe(-1234.56);
    expect(parseNumber('(0.50)')).toBe(-0.5);
  });

  it('parses negative with dash', () => {
    expect(parseNumber('-$45.99')).toBe(-45.99);
    expect(parseNumber('-1234')).toBe(-1234);
  });

  it('parses plain numbers', () => {
    expect(parseNumber('1234')).toBe(1234);
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber('1,234,567.89')).toBe(1234567.89);
  });

  it('handles number type input', () => {
    expect(parseNumber(1234)).toBe(1234);
    expect(parseNumber(0)).toBe(0);
    expect(parseNumber(-45.5)).toBe(-45.5);
    expect(parseNumber(Infinity)).toBeNull();
    expect(parseNumber(NaN)).toBeNull();
  });

  it('returns null for empty/whitespace/invalid strings', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('  ')).toBeNull();
    expect(parseNumber('N/A')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('$')).toBeNull();
    expect(parseNumber('1.2.3')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });

  it('handles currency symbols (£, €, ¥)', () => {
    expect(parseNumber('£1,234.56')).toBe(1234.56);
    expect(parseNumber('€500.00')).toBe(500);
    expect(parseNumber('¥10000')).toBe(10000);
  });

  it('handles whitespace around values', () => {
    expect(parseNumber('  $100.50  ')).toBe(100.5);
    expect(parseNumber('  (200.00)  ')).toBe(-200);
  });
});
