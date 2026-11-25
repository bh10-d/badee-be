const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIPv4(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = IPV4_RE.exec(value.trim());
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every((octet) => {
    const n = Number(octet);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * SSRF guard for printer IPs: rejects loopback (127.0.0.0/8), unspecified (0.0.0.0/8),
 * link-local / cloud metadata (169.254.0.0/16), and multicast/reserved ranges (>= 224).
 */
export function isAllowedPrinterIp(ip: string): boolean {
  if (!isValidIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a >= 224) return false;
  return true;
}

/**
 * Validates an optional camera URL: must be http:// or https:// and point to the same
 * printer IP (prevents arbitrary SSRF through camera proxy endpoints).
 */
export function validateCameraUrlForPrinter(
  cameraUrl: string | null | undefined,
  printerIp: string,
): string | null {
  if (!cameraUrl || !cameraUrl.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(cameraUrl.trim());
  } catch {
    throw new Error('Invalid cameraUrl format');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('cameraUrl must use http or https protocol');
  }
  if (parsed.username || parsed.password) {
    throw new Error('cameraUrl must not embed credentials');
  }
  if (parsed.hostname !== printerIp) {
    throw new Error(`cameraUrl host (${parsed.hostname}) must match printer IP (${printerIp})`);
  }
  return parsed.toString();
}
