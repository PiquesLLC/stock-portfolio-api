// Unit tests for the hostname allowlist guard. These run as part of the
// default unit suite (not integration) because they only exercise pure
// validation logic — no Postgres connection required.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeTestDatabaseOrThrow } from './setup-helper';

describe('assertSafeTestDatabaseOrThrow', () => {
  const originalUrl = process.env.V2_DATABASE_URL;
  const originalAllowlist = process.env.V2_TEST_DB_HOSTS;

  beforeEach(() => {
    delete process.env.V2_DATABASE_URL;
    delete process.env.V2_TEST_DB_HOSTS;
  });

  afterEach(() => {
    if (originalUrl !== undefined) process.env.V2_DATABASE_URL = originalUrl;
    else delete process.env.V2_DATABASE_URL;
    if (originalAllowlist !== undefined) process.env.V2_TEST_DB_HOSTS = originalAllowlist;
    else delete process.env.V2_TEST_DB_HOSTS;
  });

  it('throws when V2_DATABASE_URL is unset', () => {
    expect(() => assertSafeTestDatabaseOrThrow()).toThrow(/V2_DATABASE_URL is not set/);
  });

  it('throws when V2_DATABASE_URL is malformed', () => {
    process.env.V2_DATABASE_URL = 'not a url at all';
    expect(() => assertSafeTestDatabaseOrThrow()).toThrow(/not a valid URL/);
  });

  it('accepts localhost (the default allowlist)', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@localhost:5432/db';
    expect(() => assertSafeTestDatabaseOrThrow()).not.toThrow();
  });

  it('accepts 127.0.0.1 (the default allowlist)', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@127.0.0.1:5432/db';
    expect(() => assertSafeTestDatabaseOrThrow()).not.toThrow();
  });

  it('rejects subdomain-prefix injection (localhost.evil-domain.com)', () => {
    // This is the bug the reviewer caught: a substring check would let
    // an attacker (or accidental misconfiguration) route through a
    // hostname that contains "localhost" anywhere in the string.
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@localhost.evil-domain.com:5432/db';
    expect(() => assertSafeTestDatabaseOrThrow()).toThrow(/not in the allowlist/);
  });

  it('rejects suffix injection (evil-domain.localhost)', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@evil-domain.localhost:5432/db';
    expect(() => assertSafeTestDatabaseOrThrow()).toThrow(/not in the allowlist/);
  });

  it('rejects a production-looking hostname', () => {
    process.env.V2_DATABASE_URL =
      'postgresql://nala_v2:pw@nala-v2-prod.cluster-abc123.us-west-2.rds.amazonaws.com:5432/db';
    expect(() => assertSafeTestDatabaseOrThrow()).toThrow(/not in the allowlist/);
  });

  it('rejects allowlisted non-local hostname without V2_ALLOW_TRUNCATE_NON_LOCALHOST', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@nala-v2-test.internal:5432/db';
    process.env.V2_TEST_DB_HOSTS = 'nala-v2-test.internal,localhost';
    expect(() => assertSafeTestDatabaseOrThrow()).toThrow(/non-local|V2_ALLOW_TRUNCATE_NON_LOCALHOST/);
  });

  it('accepts a custom hostname when V2_TEST_DB_HOSTS overrides AND V2_ALLOW_TRUNCATE_NON_LOCALHOST=true', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@nala-v2-test.internal:5432/db';
    process.env.V2_TEST_DB_HOSTS = 'nala-v2-test.internal,localhost';
    process.env.V2_ALLOW_TRUNCATE_NON_LOCALHOST = 'true';
    try {
      expect(() => assertSafeTestDatabaseOrThrow()).not.toThrow();
    } finally {
      delete process.env.V2_ALLOW_TRUNCATE_NON_LOCALHOST;
    }
  });

  it('is case-insensitive on hostname match', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:pw@LOCALHOST:5432/db';
    expect(() => assertSafeTestDatabaseOrThrow()).not.toThrow();
  });

  it('redacts password in error message', () => {
    process.env.V2_DATABASE_URL = 'postgresql://nala_v2:supersecret@badhost.com:5432/db';
    try {
      assertSafeTestDatabaseOrThrow();
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/supersecret/);
      expect((e as Error).message).toMatch(/:\*\*\*@/);
    }
  });
});
