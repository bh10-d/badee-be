import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from './crypto.util';
import { isAllowedPrinterIp, isValidIPv4, validateCameraUrlForPrinter } from './network.util';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('AES-256-GCM credentials encryption', () => {
  it('round-trips credentials with unique IV per encryption', () => {
    const a = encryptCredentials({ password: 'secret-code' }, TEST_KEY);
    const b = encryptCredentials({ password: 'secret-code' }, TEST_KEY);
    expect(a).not.toBe(b);
    expect(decryptCredentials(a, TEST_KEY)).toEqual({ password: 'secret-code' });
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptCredentials({ lanToken: 'abc' }, TEST_KEY);
    const tampered = `${enc.slice(0, -2)}ff`;
    expect(() => decryptCredentials(tampered, TEST_KEY)).toThrow();
  });
});

describe('IPv4 & SSRF guards', () => {
  it('allows private LAN printer IPs', () => {
    expect(isValidIPv4('192.168.1.150')).toBe(true);
    expect(isAllowedPrinterIp('192.168.1.150')).toBe(true);
    expect(isAllowedPrinterIp('10.0.0.42')).toBe(true);
  });

  it('blocks loopback, metadata, and multicast ranges', () => {
    expect(isAllowedPrinterIp('127.0.0.1')).toBe(false);
    expect(isAllowedPrinterIp('169.254.169.254')).toBe(false);
    expect(isAllowedPrinterIp('0.0.0.0')).toBe(false);
    expect(isAllowedPrinterIp('224.0.0.1')).toBe(false);
  });

  it('enforces cameraUrl host matches printerIp and forbids embedded credentials', () => {
    expect(validateCameraUrlForPrinter('http://192.168.1.150:8080/stream', '192.168.1.150')).toBe(
      'http://192.168.1.150:8080/stream',
    );
    expect(() =>
      validateCameraUrlForPrinter('http://169.254.169.254/latest', '192.168.1.150'),
    ).toThrow(/must match/);
    expect(() =>
      validateCameraUrlForPrinter('http://admin:pass@192.168.1.150:8080/', '192.168.1.150'),
    ).toThrow(/credentials/);
  });
});
