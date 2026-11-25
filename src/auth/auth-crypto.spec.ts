import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.util';
import { signToken, verifyToken } from './token.util';

const SECRET = 'super_secret_test_key_at_least_32_characters_long';

describe('scrypt password hashing', () => {
  it('hashes with unique salt and verifies correctly', () => {
    const h1 = hashPassword('MyPass123!');
    const h2 = hashPassword('MyPass123!');
    expect(h1).not.toBe(h2);
    expect(verifyPassword('MyPass123!', h1)).toBe(true);
    expect(verifyPassword('WrongPass', h1)).toBe(false);
  });
});

describe('HMAC-SHA256 JWT tokens', () => {
  it('signs and verifies valid tokens', () => {
    const token = signToken(
      { sub: 'u1', email: 'renter@test.local', name: 'Renter', role: 'renter' },
      SECRET,
      3600,
    );
    const verified = verifyToken(token, SECRET);
    expect(verified?.sub).toBe('u1');
    expect(verified?.role).toBe('renter');
  });

  it('rejects tampered or expired tokens', () => {
    const expired = signToken(
      { sub: 'u1', email: 'renter@test.local', name: 'Renter', role: 'renter' },
      SECRET,
      -10,
    );
    expect(verifyToken(expired, SECRET)).toBeNull();

    const valid = signToken(
      { sub: 'u1', email: 'renter@test.local', name: 'Renter', role: 'renter' },
      SECRET,
      3600,
    );
    expect(verifyToken(`${valid.slice(0, -3)}xxx`, SECRET)).toBeNull();
  });
});
