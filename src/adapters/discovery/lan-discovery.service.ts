import { Injectable, Logger } from '@nestjs/common';
import * as dgram from 'node:dgram';
import * as os from 'node:os';
import { isAllowedPrinterIp } from '../../common/network.util';

export interface DiscoveredPrinter {
  ip: string;
  brand: 'elegoo' | 'anycubic';
  model: string;
  name: string;
  serialNumber: string | null;
  firmware: string | null;
  protocol: 'sdcp-udp' | 'anycubic-lan-http';
}

export interface LanDiscoveryResult {
  scannedSubnets: string[];
  durationMs: number;
  printers: DiscoveredPrinter[];
}

export interface LanDiscoveryOptions {
  /** Optional private IPv4 /24 prefix like "192.168.1" or "192.168.1.0/24". */
  subnet?: string;
  /** Discovery timeout in milliseconds (clamped 1000..5000). */
  timeoutMs?: number;
}

/**
 * Validates and normalizes an optional private RFC1918 /24 subnet prefix (e.g. "192.168.1").
 * Returns null if the subnet is invalid or not a private LAN range (prevents SSRF).
 */
export function normalizePrivateSubnet(raw: string): string | null {
  const cleaned = raw.trim().replace(/\/24$/, '');
  const parts = cleaned.split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b] = nums;
  // Strictly allow RFC1918 private LAN subnets only (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
  const isRfc1918 =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isRfc1918) return null;
  const prefix = `${nums[0]}.${nums[1]}.${nums[2]}`;
  if (!isAllowedPrinterIp(`${prefix}.10`)) return null;
  return prefix;
}

/**
 * Auto-detects private IPv4 /24 subnets attached to the local machine's LAN/Wi-Fi interfaces.
 */
export function detectLocalSubnets(): string[] {
  const ifaces = os.networkInterfaces();
  const prefixes = new Set<string>();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const prefix = normalizePrivateSubnet(addr.address);
      if (prefix) prefixes.add(prefix);
    }
  }
  // Cap to at most 2 local /24 subnets so scans stay fast (< 3s)
  return Array.from(prefixes).slice(0, 2);
}

/**
 * Parses an Elegoo SDCP UDP `:3000` response to `M99999`.
 */
export function parseElegooSdcpPacket(raw: string, fallbackIp: string): DiscoveredPrinter | null {
  try {
    const parsed = JSON.parse(raw) as {
      Data?: {
        Name?: string;
        MachineName?: string;
        BrandName?: string;
        MainboardIP?: string;
        MainboardID?: string;
        FirmwareVersion?: string;
      };
    };
    const data = parsed?.Data;
    if (!data || typeof data !== 'object') return null;

    const ip =
      typeof data.MainboardIP === 'string' && isAllowedPrinterIp(data.MainboardIP)
        ? data.MainboardIP
        : fallbackIp;
    if (!isAllowedPrinterIp(ip)) return null;

    const rawName = (data.Name || data.MachineName || 'Elegoo Printer').trim();
    const lowerMachine = `${data.MachineName ?? ''} ${rawName}`.toLowerCase();
    const model =
      lowerMachine.includes('centauri') || lowerMachine.includes('cc2') ? 'cc2' : 'cc2';

    return {
      ip,
      brand: 'elegoo',
      model,
      name: rawName,
      serialNumber: typeof data.MainboardID === 'string' && data.MainboardID ? data.MainboardID : null,
      firmware:
        typeof data.FirmwareVersion === 'string' && data.FirmwareVersion
          ? data.FirmwareVersion
          : null,
      protocol: 'sdcp-udp',
    };
  } catch {
    return null;
  }
}

/**
 * Parses an Anycubic LAN Mode HTTP `:18910/info` JSON response.
 */
export function parseAnycubicInfoResponse(
  payload: unknown,
  ip: string,
): DiscoveredPrinter | null {
  if (!payload || typeof payload !== 'object' || !isAllowedPrinterIp(ip)) return null;
  const obj = payload as Record<string, unknown>;
  const nested =
    obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : obj;

  const modelStr = String(nested.model ?? nested.machine_name ?? nested.device_type ?? '');
  const nameStr = String(nested.name ?? nested.device_name ?? modelStr ?? '');
  const sn = nested.cn ?? nested.sn ?? nested.device_id ?? nested.id ?? null;
  const fw = nested.firmware ?? nested.firmware_version ?? nested.version ?? null;

  // Require at least one recognizable Anycubic / printer info field
  if (!modelStr && !nameStr && !sn) return null;

  const lower = `${modelStr} ${nameStr}`.toLowerCase();
  const model = lower.includes('kobra') || lower.includes('k4') ? 'kobra-x' : 'kobra-x';

  return {
    ip,
    brand: 'anycubic',
    model,
    name: nameStr.trim() || `Anycubic ${modelStr || 'Kobra X'}`,
    serialNumber: typeof sn === 'string' && sn.trim() ? sn.trim() : null,
    firmware: typeof fw === 'string' && fw.trim() ? fw.trim() : null,
    protocol: 'anycubic-lan-http',
  };
}

/**
 * Multi-brand LAN discovery service (Elegoo SDCP UDP `:3000` + Anycubic LAN HTTP `:18910/info`).
 * Strictly restricted to private RFC1918 subnets so it can never be abused for external SSRF.
 */
@Injectable()
export class LanDiscoveryService {
  private readonly logger = new Logger(LanDiscoveryService.name);

  async scan(opts: LanDiscoveryOptions = {}): Promise<LanDiscoveryResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.max(1000, Math.min(5000, Number(opts.timeoutMs) || 2200));

    let prefixes: string[];
    if (opts.subnet && opts.subnet.trim()) {
      const normalized = normalizePrivateSubnet(opts.subnet);
      if (!normalized) {
        throw new Error('Subnet must be a private LAN IPv4 /24 range (e.g. 192.168.1.0/24)');
      }
      prefixes = [normalized];
    } else {
      prefixes = detectLocalSubnets();
    }

    const [elegooPrinters, anycubicPrinters] = await Promise.all([
      this.scanElegooSdcp(prefixes, timeoutMs),
      this.scanAnycubicLanHttp(prefixes, Math.min(timeoutMs, 2600)),
    ]);

    const byIp = new Map<string, DiscoveredPrinter>();
    for (const p of [...elegooPrinters, ...anycubicPrinters]) {
      if (!byIp.has(p.ip)) byIp.set(p.ip, p);
    }

    const printers = Array.from(byIp.values()).sort((a, b) => a.ip.localeCompare(b.ip));
    this.logger.log(
      `LAN scan across [${prefixes.map((p) => `${p}.0/24`).join(', ')}] found ${printers.length} printer(s) in ${Date.now() - startedAt}ms`,
    );

    return {
      scannedSubnets: prefixes.map((p) => `${p}.0/24`),
      durationMs: Date.now() - startedAt,
      printers,
    };
  }

  private scanElegooSdcp(prefixes: string[], timeoutMs: number): Promise<DiscoveredPrinter[]> {
    return new Promise((resolve) => {
      const found = new Map<string, DiscoveredPrinter>();
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        resolve(Array.from(found.values()));
      };

      const timer = setTimeout(finish, timeoutMs);

      socket.on('error', () => {
        clearTimeout(timer);
        finish();
      });

      socket.on('message', (msg, rinfo) => {
        const printer = parseElegooSdcpPacket(msg.toString('utf8'), rinfo.address);
        if (printer) {
          found.set(printer.ip, printer);
        }
      });

      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          const payload = Buffer.from('M99999', 'utf8');
          const targets = new Set<string>(['255.255.255.255']);
          for (const prefix of prefixes) {
            targets.add(`${prefix}.255`);
          }
          for (const target of targets) {
            socket.send(payload, 3000, target, () => {
              /* ignore individual broadcast send errors */
            });
          }
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    });
  }

  private async scanAnycubicLanHttp(
    prefixes: string[],
    budgetMs: number,
  ): Promise<DiscoveredPrinter[]> {
    if (prefixes.length === 0) return [];
    const deadline = Date.now() + budgetMs;
    const hosts: string[] = [];
    for (const prefix of prefixes) {
      for (let last = 1; last <= 254; last++) {
        hosts.push(`${prefix}.${last}`);
      }
    }

    const found: DiscoveredPrinter[] = [];
    const concurrency = 32;
    let cursor = 0;

    const worker = async () => {
      while (cursor < hosts.length && Date.now() < deadline) {
        const ip = hosts[cursor++];
        try {
          const res = await fetch(`http://${ip}:18910/info`, {
            method: 'GET',
            signal: AbortSignal.timeout(280),
          });
          if (!res.ok) continue;
          const json = await res.json().catch(() => null);
          const parsed = parseAnycubicInfoResponse(json, ip);
          if (parsed) found.push(parsed);
        } catch {
          /* host offline or port closed — expected */
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return found;
  }
}
