import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
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

    // Probe LAN Mode control endpoint (:18910/info) with strict timeout
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
        if (typeof info.model_id === 'string') {
          this.modelId = info.model_id;
        }
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

    const clientId = `printfarm_${randomBytes(6).toString('hex')}`;
    this.client = mqtt.connect(`mqtts://${this.ip}:9883`, {
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
