import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SALT_BYTES = 16;
const KEY_LEN = 64;

/**
 * Hashes a password with Node built-in `scryptSync` and a unique 16-byte random salt.
 * Format: `scrypt:<saltHex>:<derivedKeyHex>`
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_LEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LEN) return false;
  const actual = scryptSync(plain, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}
