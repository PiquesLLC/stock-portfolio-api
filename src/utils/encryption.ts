import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const CURRENT_KEY_VERSION = 'v1';

function getKey(): Buffer {
  const key = config.mfaEncryptionKey;
  if (!key || key.length !== 64) {
    throw new Error('MFA_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CURRENT_KEY_VERSION}:${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decrypt(data: string): string {
  const parts = data.split(':');

  let ivHex: string, encHex: string, tagHex: string;

  if (parts.length === 4 && parts[0].startsWith('v')) {
    // Versioned format: v1:iv:ciphertext:tag
    [, ivHex, encHex, tagHex] = parts;
  } else if (parts.length === 3) {
    // Legacy format: iv:ciphertext:tag (pre-versioning)
    [ivHex, encHex, tagHex] = parts;
  } else {
    throw new Error('Malformed ciphertext: expected [version:]iv:ciphertext:tag format');
  }

  if (ivHex.length !== IV_LENGTH * 2 || tagHex.length !== 32) {
    throw new Error('Malformed ciphertext: invalid IV or auth tag length');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
