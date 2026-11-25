import { EventEmitter } from 'events';
import { createDecipheriv, createHash, randomBytes } from 'crypto';
import mqtt, { type MqttClient } from 'mqtt';
import type {
  DriverInitConfig,
  IPrinterDriver,
  PrinterCapabilities,
  PrinterWorkState,
  UnifiedPrinterState,
} from '../../../core/printer-driver.interface';

const MAX_NOZZLE_TEMP = 300;
const MAX_BED_TEMP = 110;

export interface AnycubicCtrlCredentials {
  broker?: string;
  username?: string;
  password?: string;
  deviceId?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
}

/**
 * Computes Anycubic LAN Mode `/ctrl` request signature:
 * `md5(md5(token[0:16]) + ts + nonce)` (lowercase hex).
 */
export function computeAnycubicCtrlSign(token: string, ts: string, nonce: string): string {
  const signKey = token.slice(0, 16);
  const inner = createHash('md5').update(signKey, 'utf8').digest('hex');
  return createHash('md5').update(`${inner}${ts}${nonce}`, 'utf8').digest('hex');
}

/**
 * Decrypts Anycubic LAN Mode `/ctrl` AES-128-CBC response (`data.info`) using `token[16:32]`
 * as the 16-byte AES key and `data.token` as IV source.
 */
export function decryptAnycubicCtrlInfo(
  encryptedInfo: string,
  baseToken: string,
  ivToken?: string,
): AnycubicCtrlCredentials | null {
  if (!encryptedInfo || baseToken.length < 32) return null;
  const key = Buffer.from(baseToken.slice(16, 32), 'utf8');
  const ivCandidates: Buffer[] = [];
  if (ivToken && ivToken.length >= 16) {
    ivCandidates.push(Buffer.from(ivToken.slice(0, 16), 'utf8'));
    ivCandidates.push(Buffer.from(ivToken.slice(-16), 'utf8'));
    ivCandidates.push(createHash('md5').update(ivToken, 'utf8').digest());
  }
  ivCandidates.push(Buffer.from(baseToken.slice(0, 16), 'utf8'));
  ivCandidates.push(key);
  ivCandidates.push(Buffer.alloc(16, 0));

  const encodings: Array<'base64' | 'hex'> = ['base64', 'hex'];

  for (const enc of encodings) {
    let cipherBuf: Buffer;
    try {
      cipherBuf = Buffer.from(encryptedInfo, enc);
      if (cipherBuf.length === 0 || cipherBuf.length % 16 !== 0) continue;
    } catch {
      continue;
    }

    for (const iv of ivCandidates) {
      if (iv.length !== 16) continue;
      try {
        const decipher = createDecipheriv('aes-128-cbc', key, iv);
        const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString('utf8');
        const parsed = JSON.parse(plain) as Record<string, unknown>;
        return {
          broker: typeof parsed.broker === 'string' ? parsed.broker : undefined,
          username: typeof parsed.username === 'string' ? parsed.username : undefined,
          password: typeof parsed.password === 'string' ? parsed.password : undefined,
          deviceId:
            typeof parsed.deviceId === 'string'
              ? parsed.deviceId
              : typeof parsed.device_id === 'string'
                ? parsed.device_id
                : undefined,
          clientCertPem:
            typeof parsed.cert === 'string'
              ? parsed.cert
              : typeof parsed.clientCert === 'string'
                ? parsed.clientCert
                : undefined,
          clientKeyPem:
            typeof parsed.key === 'string'
              ? parsed.key
              : typeof parsed.clientKey === 'string'
                ? parsed.clientKey
                : undefined,
        };
      } catch {
        /* try next IV/encoding candidate */
      }
    }
  }
  return null;
}

interface KobraXCredentials {
  lanToken?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  deviceId?: string;
  modelId?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
}

/**
 * Anycubic Kobra X (K4Pro) LAN Mode driver.
 *
 * Protocol flow:
 * 1. Queries `http://<ip>:18910/info` to verify LAN Mode & discover device metadata.
 * 2. Connects to local mTLS MQTT broker at `mqtts://<ip>:9883` for telemetry & control.
 * 3. Exposes local HTTP-FLV camera stream at `http://<ip>:18088/live/<token>` (consumed via MediaMTX).
 */
export class AnycubicKobraXDriver extends EventEmitter implements IPrinterDriver {
  readonly printerId: string;
  readonly brand = 'anycubic' as const;
  readonly model = 'kobra-x';

  private readonly ip: string;
  private readonly creds: KobraXCredentials;
  private readonly cameraOverride: string | null;

  private client: MqttClient | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private deviceId = '';
  private modelId = '';
  private state: UnifiedPrinterState;

  constructor(config: DriverInitConfig) {
    super();
    this.printerId = config.printerId;
    this.ip = config.ip;
    this.creds = config.credentials as KobraXCredentials;
    this.cameraOverride = config.cameraUrl ?? null;
    this.deviceId = this.creds.deviceId ?? config.serialNumber ?? '';
    this.modelId = this.creds.modelId ?? '';

    const defaultCam = this.creds.lanToken
      ? `http://${this.ip}:18088/live/${encodeURIComponent(this.creds.lanToken)}`
      : null;

    this.state = {
      printerId: this.printerId,
      brand: this.brand,
      model: this.model,
      ip: this.ip,
      serialNumber: this.deviceId || null,
      connectionState: 'disconnected',
      workState: 'offline',
      statusText: 'Offline',
      temperatures: {
        nozzle: { actual: 0, target: 0 },
        bed: { actual: 0, target: 0 },
        chamber: { actual: null },
      },
      print: null,
      fans: { model: null, aux: null, case: null },
      lightOn: null,
      camera: {
        available: Boolean(this.cameraOverride || defaultCam),
        streamUrl: this.cameraOverride || defaultCam,
        protocol: 'flv',
      },
      updatedAt: Date.now(),
    };
  }

  getState(): UnifiedPrinterState {
    return this.state;
  }

  getCapabilities(): PrinterCapabilities {
    return {
      pause: true,
      resume: true,
      stop: true,
      emergencyStop: true,
      setTemperature: true,
      home: true,
      light: true,
      camera: true,
      multiMaterial: true,
    };
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.clearTimers();
    this.discardClient();
    this.setConnectionState('connecting');

    // 1. Probe LAN Mode discovery endpoint (:18910/info) + signed /ctrl credential handshake
    let brokerUrl = `mqtts://${this.ip}:9883`;
    let infoToken = '';
    let ctrlInfoUrl = `http://${this.ip}:18910/ctrl`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`http://${this.ip}:18910/info`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const info = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const discoveredId =
          (typeof info.device_id === 'string' && info.device_id) ||
          (typeof info.cn === 'string' && info.cn) ||
          this.deviceId;
        if (discoveredId && discoveredId !== this.deviceId) {
          this.deviceId = discoveredId;
          this.state.serialNumber = discoveredId;
          this.emit('sn', discoveredId);
        }
        const discoveredModelId = info.modelId ?? info.model_id;
        if (discoveredModelId !== undefined && discoveredModelId !== null) {
          this.modelId = String(discoveredModelId);
        }
        if (typeof info.ctrlInfoUrl === 'string' && info.ctrlInfoUrl.startsWith(`http://${this.ip}:`)) {
          ctrlInfoUrl = info.ctrlInfoUrl;
        }
        if (typeof info.token === 'string' && info.token) {
          infoToken = info.token;
          if (!this.creds.lanToken) {
            this.creds.lanToken = info.token;
            if (!this.cameraOverride) {
              this.state.camera = {
                available: true,
                streamUrl: `http://${this.ip}:18088/live/${encodeURIComponent(info.token)}`,
                protocol: 'flv',
              };
            }
          }
        }
        this.state.statusText = 'LAN Ready (Authenticating...)';
        this.emitState();
      }
    } catch (err) {
      if (this.stopped) return;
      this.emit('event', {
        level: 'warn',
        type: 'lan_probe_failed',
        message: `Kobra X LAN probe (${this.ip}:18910) unreachable: ${(err as Error).message}`,
      });
      this.setConnectionState('disconnected');
      this.scheduleRetry();
      return;
    }

    if (this.stopped) return;

    // 2. Perform signed POST /ctrl handshake to dynamically obtain local MQTT username/password
    if (infoToken.length >= 32 && !this.creds.mqttUsername) {
      try {
        const ts = String(Date.now());
        const nonce = randomBytes(3).toString('hex');
        const did = randomBytes(16).toString('hex');
        const sign = computeAnycubicCtrlSign(infoToken, ts, nonce);
        const ctrlUrl = `${ctrlInfoUrl}?ts=${encodeURIComponent(ts)}&nonce=${encodeURIComponent(nonce)}&sign=${encodeURIComponent(sign)}&did=${encodeURIComponent(did)}`;

        const ctrlRes = await fetch(ctrlUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        });
        if (ctrlRes.ok) {
          const ctrlJson = (await ctrlRes.json().catch(() => ({}))) as Record<string, unknown>;
          const dataObj =
            ctrlJson.data && typeof ctrlJson.data === 'object'
              ? (ctrlJson.data as Record<string, unknown>)
              : ctrlJson;

          if (typeof dataObj.info === 'string') {
            const decrypted = decryptAnycubicCtrlInfo(
              dataObj.info,
              infoToken,
              typeof dataObj.token === 'string' ? dataObj.token : undefined,
            );
            if (decrypted) {
              if (decrypted.broker && decrypted.broker.includes(this.ip)) {
                brokerUrl = decrypted.broker;
              }
              if (decrypted.username) this.creds.mqttUsername = decrypted.username;
              if (decrypted.password) this.creds.mqttPassword = decrypted.password;
              if (decrypted.clientCertPem) this.creds.clientCertPem = decrypted.clientCertPem;
              if (decrypted.clientKeyPem) this.creds.clientKeyPem = decrypted.clientKeyPem;
              if (decrypted.deviceId && decrypted.deviceId !== this.deviceId) {
                this.deviceId = decrypted.deviceId;
                this.state.serialNumber = decrypted.deviceId;
                this.emit('sn', decrypted.deviceId);
              }
            } else {
              this.emit('event', {
                level: 'warn',
                type: 'ctrl_decrypt_failed',
                message: `Kobra X /ctrl returned encrypted credentials that could not be decrypted`,
              });
            }
          }
        }
      } catch (err) {
        this.emit('event', {
          level: 'warn',
          type: 'ctrl_handshake_failed',
          message: `Kobra X /ctrl handshake failed: ${(err as Error).message}`,
        });
      }
    }

    if (this.stopped) return;

    const clientId = `printfarm_${randomBytes(6).toString('hex')}`;
    this.client = mqtt.connect(brokerUrl, {
      clientId,
      username: this.creds.mqttUsername || undefined,
      password: this.creds.mqttPassword || this.creds.lanToken || undefined,
      cert: this.creds.clientCertPem || undefined,
      key: this.creds.clientKeyPem || undefined,
      rejectUnauthorized: false,
      protocolVersion: 4,
      keepalive: 60,
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      const prefix =
        this.modelId && this.deviceId
          ? `anycubic/anycubicCloud/v1/printer/public/${this.modelId}/${this.deviceId}/#`
          : 'anycubic/#';
      this.client?.subscribe(prefix, { qos: 1 });
      this.setConnectionState('connected');
      this.state.workState = 'idle';
      this.state.statusText = 'Idle';
      this.emitState();
      // Request initial telemetry & enable local FLV camera stream on LAN
      this.publishControl('info', 'query', {});
      this.publishControl('video', 'startCapture', {});
      this.emit('event', {
        level: 'info',
        type: 'connected',
        message: `Connected to Anycubic Kobra X LAN MQTT (${this.ip}:9883)`,
      });
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err: Error) => {
      this.emit('event', {
        level: 'warn',
        type: 'mqtt_error',
        message: `Kobra X MQTT error: ${err.message}`,
      });
    });

    this.client.on('close', () => {
      this.state = {
        ...this.state,
        connectionState: 'disconnected',
        workState: 'offline',
        statusText: 'Offline',
        updatedAt: Date.now(),
      };
      this.emitState();
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.discardClient();
    this.state = {
      ...this.state,
      connectionState: 'disconnected',
      workState: 'offline',
      statusText: 'Offline',
      updatedAt: Date.now(),
    };
    this.emitState();
  }

  async startPrint(filename: string): Promise<void> {
    this.publishControl('print', 'start', { filename });
  }

  async pause(): Promise<void> {
    this.publishControl('print', 'pause', {});
  }

  async resume(): Promise<void> {
    this.publishControl('print', 'resume', {});
  }

  async stop(): Promise<void> {
    this.publishControl('print', 'stop', {});
  }

  async emergencyStop(): Promise<void> {
    this.publishControl('print', 'stop', { emergency: true });
  }

  async setTemperature(target: { nozzle?: number; bed?: number }): Promise<void> {
    const data: Record<string, number> = {};
    if (target.nozzle !== undefined) {
      if (target.nozzle < 0 || target.nozzle > MAX_NOZZLE_TEMP) {
        throw new Error(`Nozzle temperature out of safe range (0-${MAX_NOZZLE_TEMP}°C)`);
      }
      data.target_nozzle_temp = Math.round(target.nozzle);
    }
    if (target.bed !== undefined) {
      if (target.bed < 0 || target.bed > MAX_BED_TEMP) {
        throw new Error(`Bed temperature out of safe range (0-${MAX_BED_TEMP}°C)`);
      }
      data.target_hotbed_temp = Math.round(target.bed);
    }
    if (Object.keys(data).length > 0) {
      this.publishControl('print', 'update', { settings: data });
    }
  }

  async home(axes = 'XYZ'): Promise<void> {
    this.publishControl('axis', 'move', { home: axes });
  }

  async setLight(on: boolean): Promise<void> {
    this.publishControl('light', 'update', { status: on ? 1 : 0 });
  }

  async move(axis: 'x' | 'y' | 'z', deltaMm: number): Promise<void> {
    const clamped = Math.max(-50, Math.min(50, deltaMm));
    this.publishControl('axis', 'move', { axis: axis.toUpperCase(), distance: clamped });
  }

  async setFan(fan: 'model' | 'aux' | 'case', speedPercent: number): Promise<void> {
    const pct = Math.max(0, Math.min(100, Math.round(speedPercent)));
    this.publishControl('print', 'update', { settings: { [`${fan}_fan_speed`]: pct } });
  }

  async setSpeedMode(mode: 50 | 100 | 130 | 160): Promise<void> {
    this.publishControl('print', 'update', { settings: { print_speed_pct: mode } });
  }

  async filamentOp(op: 'load' | 'unload'): Promise<void> {
    this.publishControl('filament', op, {});
  }

  private publishControl(type: string, action: string, data: Record<string, unknown>): void {
    if (!this.client || this.state.connectionState !== 'connected') {
      throw new Error(`Anycubic Kobra X (${this.printerId}) is not connected`);
    }
    const topic =
      this.modelId && this.deviceId
        ? `anycubic/anycubicCloud/v1/slicer/printer/${this.modelId}/${this.deviceId}/${type}`
        : `anycubic/lan/${type}`;
    const payload = {
      type,
      action,
      timestamp: Date.now(),
      msgid: randomBytes(8).toString('hex'),
      data,
    };
    this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
  }

  private handleMessage(_topic: string, payload: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const data = (msg.data as Record<string, unknown> | undefined) ?? msg;
    const rawState = String(msg.state ?? data.state ?? '').toLowerCase();

    let workState: PrinterWorkState = this.state.workState;
    let statusText = this.state.statusText;
    if (rawState) {
      if (rawState.includes('print')) {
        workState = 'printing';
        statusText = 'Printing';
      } else if (rawState.includes('pause')) {
        workState = 'paused';
        statusText = 'Paused';
      } else if (rawState.includes('free') || rawState.includes('idle')) {
        workState = 'idle';
        statusText = 'Idle';
      } else if (rawState.includes('err') || rawState.includes('fail')) {
        workState = 'error';
        statusText = 'Error';
      }
    }

    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;

    this.state = {
      ...this.state,
      workState,
      statusText,
      temperatures: {
        nozzle: {
          actual: num(data.curr_nozzle_temp, this.state.temperatures.nozzle.actual),
          target: num(data.target_nozzle_temp, this.state.temperatures.nozzle.target),
        },
        bed: {
          actual: num(data.curr_hotbed_temp, this.state.temperatures.bed.actual),
          target: num(data.target_hotbed_temp, this.state.temperatures.bed.target),
        },
        chamber: this.state.temperatures.chamber,
      },
      print:
        workState === 'printing' || workState === 'paused'
          ? {
              filename:
                typeof data.filename === 'string'
                  ? data.filename
                  : (this.state.print?.filename ?? ''),
              progress: num(data.progress, this.state.print?.progress ?? 0),
              currentLayer:
                typeof data.curr_layer === 'number'
                  ? data.curr_layer
                  : (this.state.print?.currentLayer ?? null),
              totalLayers:
                typeof data.total_layers === 'number'
                  ? data.total_layers
                  : (this.state.print?.totalLayers ?? null),
              elapsedSec:
                typeof data.print_time === 'number'
                  ? data.print_time * 60
                  : (this.state.print?.elapsedSec ?? null),
              remainingSec:
                typeof data.remain_time === 'number'
                  ? data.remain_time * 60
                  : (this.state.print?.remainingSec ?? null),
            }
          : workState === 'idle'
            ? null
            : this.state.print,
      updatedAt: Date.now(),
    };
    this.emitState();
  }

  private setConnectionState(connectionState: UnifiedPrinterState['connectionState']): void {
    this.state = {
      ...this.state,
      connectionState,
      workState: connectionState === 'connected' ? 'idle' : 'offline',
      statusText: connectionState === 'connected' ? 'Idle' : 'Offline',
      updatedAt: Date.now(),
    };
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.state);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => void this.connect(), 15_000);
  }

  private clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private discardClient(): void {
    const client = this.client;
    if (!client) return;
    this.client = null;
    client.removeAllListeners();
    client.on('error', () => {});
    client.end(true);
  }
}
