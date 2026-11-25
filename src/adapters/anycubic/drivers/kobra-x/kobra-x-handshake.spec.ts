import { createCipheriv } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  computeAnycubicCtrlSign,
  decryptAnycubicCtrlInfo,
} from './kobra-x.driver';

describe('Anycubic Kobra X LAN Mode /ctrl handshake', () => {
  const token = '0123456789abcdeffedcba9876543210';

  it('computes deterministic MD5 signature for POST /ctrl', () => {
    const sig = computeAnycubicCtrlSign(token, '1700000000000', 'ab12cd');
    expect(sig).toMatch(/^[a-f0-9]{32}$/);
    expect(sig).toBe(computeAnycubicCtrlSign(token, '1700000000000', 'ab12cd'));
  });

  it('decrypts AES-128-CBC /ctrl credentials blob using token[16:32]', () => {
    const key = Buffer.from(token.slice(16, 32), 'utf8');
    const ivToken = 'abcdef1234567890';
    const iv = Buffer.from(ivToken, 'utf8');
    const plain = JSON.stringify({
      broker: 'mqtts://192.168.10.207:9883',
      username: 'lan-user',
      password: 'lan-password',
      deviceId: 'kobra-x-20030',
    });

    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');

    const result = decryptAnycubicCtrlInfo(encrypted, token, ivToken);
    expect(result).toEqual({
      broker: 'mqtts://192.168.10.207:9883',
      username: 'lan-user',
      password: 'lan-password',
      deviceId: 'kobra-x-20030',
      clientCertPem: undefined,
      clientKeyPem: undefined,
    });
  });
});
