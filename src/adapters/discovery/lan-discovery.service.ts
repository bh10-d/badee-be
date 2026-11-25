import { Injectable, Logger } from '@nestjs/common';
import * as dgram from 'node:dgram';
import * as net from 'node:net';
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

const VIRTUAL_IFACE_PATTERN =
  /vethernet|wsl|docker|hyper-v|vmware|virtualbox|vbox|tailscale|zerotier|hamachi|loopback|utun|br-/i;

/**
 * Auto-detects private IPv4 /24 subnets attached to physical LAN/Wi-Fi interfaces,
 * filtering out WSL/Docker/Hyper-V virtual adapters that waste scan budget.
 */
export function detectLocalSubnets(): string[] {
  const ifaces = os.networkInterfaces();
  const physical = new Set<string>();
  const fallback = new Set<string>();

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    const isVirtual = VIRTUAL_IFACE_PATTERN.test(name);
    for (const addr of entries) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const prefix = normalizePrivateSubnet(addr.address);
      if (!prefix) continue;
      if (isVirtual) fallback.add(prefix);
      else physical.add(prefix);
    }
  }

  const chosen = physical.size > 0 ? Array.from(physical) : Array.from(fallback);
  // Prioritize 192.168.x home/workshop LANs first, capped at 2 subnets
  return chosen
    .sort((a, b) => (a.startsWith('192.168.') ? -1 : b.startsWith('192.168.') ? 1 : a.localeCompare(b)))
    .slice(0, 2);
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
    // Distinguish Centauri Carbon 2 (CC2 — MQTT :1883) vs Centauri Carbon (CC1 — SDCP WS :3030)
    const isCc2 =
      lowerMachine.includes('cc2') ||
      lowerMachine.includes('carbon 2') ||
      lowerMachine.includes('carbon2');
    const model = isCc2 ? 'cc2' : 'cc1';

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
 * Real Anycubic Kobra 3 / S1 / Kobra X firmware returns:
 * `{ ctrlType: "lan", token: "...", ctrlInfoUrl: "http://<ip>:18910/ctrl", modelId: 20025, cn: "...", usn: "uuid:fdm:..." }`
 */
export function parseAnycubicInfoResponse(
  payload: unknown,
  ip: string,
): DiscoveredPrinter | null {
  if (!payload || typeof payload !== 'object' || !isAllowedPrinterIp(ip)) return null;
  const obj = payload as Record<string, unknown>;
  const nested =
    obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : obj;

  const ctrlType = typeof nested.ctrlType === 'string' ? nested.ctrlType : '';
  const usn = typeof nested.usn === 'string' ? nested.usn : '';
  const modelId = nested.modelId ?? nested.model_id ?? null;
  const modelStr = String(nested.model ?? nested.machine_name ?? nested.device_type ?? '');
  const nameStr = String(nested.name ?? nested.device_name ?? modelStr ?? '');
  const rawSn = nested.cn ?? nested.sn ?? nested.device_id ?? nested.id ?? null;
  const sn = rawSn !== null && rawSn !== undefined && String(rawSn).trim() ? String(rawSn).trim() : null;
  const fw = nested.firmware ?? nested.firmware_version ?? nested.version ?? null;

  // Recognize real Anycubic LAN Mode fields (`ctrlType`, `ctrlInfoUrl`, `modelId`, `usn`, `cn`, `model`)
  const isAnycubicShape = Boolean(
    ctrlType ||
      nested.ctrlInfoUrl ||
      modelId !== null ||
      usn.toLowerCase().includes('fdm') ||
      modelStr ||
      nameStr ||
      sn,
  );
  if (!isAnycubicShape) return null;

  const displayName =
    nameStr.trim() ||
    (modelId !== null ? `Anycubic Kobra (${modelId})` : `Anycubic Kobra (${ip.split('.').pop()})`);

  return {
    ip,
    brand: 'anycubic',
    model: 'kobra-x',
    name: displayName,
    serialNumber: sn,
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
      this.scanAnycubicLanHttp(prefixes, Math.max(timeoutMs, 4200)),
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

  private probeTcpPort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
      sock.connect(port, ip);
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
    const concurrency = 64;
    let cursor = 0;

    const worker = async () => {
      while (cursor < hosts.length && Date.now() < deadline) {
        const ip = hosts[cursor++];
        try {
          const res = await fetch(`http://${ip}:18910/info`, {
            method: 'GET',
            signal: AbortSignal.timeout(500),
          });
          if (res.ok) {
            const json = await res.json().catch(() => null);
            const parsed = parseAnycubicInfoResponse(json, ip);
            if (parsed) {
              found.push(parsed);
              continue;
            }
          }
          // Some Anycubic Kobra firmwares return 401/403/404 on unauthenticated /info
          // while still running LAN Mode on :18910 + mTLS MQTT :9883.
          const hasMqtt9883 = await this.probeTcpPort(ip, 9883, 350);
          if (hasMqtt9883) {
            found.push({
              ip,
              brand: 'anycubic',
              model: 'kobra-x',
              name: `Anycubic LAN (${ip.split('.').pop()})`,
              serialNumber: null,
              firmware: null,
              protocol: 'anycubic-lan-http',
            });
          }
        } catch {
          /* host offline or :18910 closed — expected */
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return found;
  }
}
