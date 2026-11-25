import { createHmac, timingSafeEqual } from 'crypto';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'renter';
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function signToken(
  payload: Omit<AuthTokenPayload, 'exp'>,
  secret: string,
  ttlSec: number,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(body).toString('utf8')) as AuthTokenPayload;
    if (!parsed.sub || !parsed.role || typeof parsed.exp !== 'number') return null;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}
