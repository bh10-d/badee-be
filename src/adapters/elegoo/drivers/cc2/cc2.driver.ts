import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import mqtt, { type MqttClient } from 'mqtt';
import WebSocket from 'ws';
import type {
  DriverInitConfig,
  IPrinterDriver,
  PrinterCapabilities,
  PrinterWorkState,
  UnifiedPrinterState,
} from '../../../core/printer-driver.interface';
import {
  CC2_CRITICAL_EXCEPTIONS,
  CC2_EXCEPTION_NAMES,
  CC2_STATUS_NAMES,
  CC2_SUB_STATUS_NAMES,
} from './cc2.protocol';

const MAX_NOZZLE_TEMP = 300;
const MAX_BED_TEMP = 110;

/**
 * Elegoo Centauri Carbon 2 (CC2) driver — ported & optimized from legacy elegoo-web.
 * Maintains strictly ONE MQTT connection per physical printer instance.
 */
export class ElegooCc2Driver extends EventEmitter implements IPrinterDriver {
  readonly printerId: string;
  readonly brand = 'elegoo' as const;
  readonly model = 'cc2';

  private readonly ip: string;
  private readonly password: string;
  private readonly cameraOverride: string | null;

  private client: MqttClient | null = null;
  private clientId: string;
  private requestId: string;
  private sn: string;
  private commandId = 0;

  private connected = false;
  private brokerConnected = false;
  private rejected = false;
  private heartbeatMissed = 0;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private registerTimer: ReturnType<typeof setInterval> | null = null;
  private slowRegisterTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deduplicates repeating exception_status codes so DB is only written on fault transition. */
  private activeExceptions = new Set<number>();

  private state: UnifiedPrinterState;

  constructor(config: DriverInitConfig) {
    super();
    this.printerId = config.printerId;
    this.ip = config.ip;
    this.password =
      typeof config.credentials.password === 'string' && config.credentials.password.length > 0
        ? config.credentials.password
        : '123456';
    this.sn = config.serialNumber ?? '';
    this.cameraOverride = config.cameraUrl ?? null;
    this.clientId = randomBytes(5).toString('hex');
    this.requestId = randomBytes(13).toString('hex');

    this.state = {
      printerId: this.printerId,
      brand: this.brand,
      model: this.model,
      ip: this.ip,
      serialNumber: this.sn || null,
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
        available: false,
        streamUrl: this.cameraOverride || `http://${this.ip}:8080`,
        protocol: 'mjpeg',
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

  connect(): void {
    this.clearTimers();
    this.discardClient();
    this.updateConnectionState('connecting');

    const url = `mqtt://${this.ip}:1883`;
    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: 'elegoo',
      password: this.password,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      protocolVersion: 4,
    });

    this.client.on('connect', () => {
      this.brokerConnected = true;
      this.client?.subscribe('elegoo/#', { qos: 1 });
      if (this.sn) {
        this.updateConnectionState('registering');
        this.register();
      } else {
        this.updateConnectionState('awaiting_sn');
      }
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err: Error) => {
      this.emit('event', {
        level: 'warn',
        type: 'mqtt_error',
        message: `MQTT error: ${err.message}`,
      });
    });

    this.client.on('close', () => {
      const wasUp = this.connected || this.brokerConnected;
      this.connected = false;
      this.brokerConnected = false;
      this.rejected = false;
      this.clearTimers();
      this.state = {
        ...this.state,
        connectionState: 'disconnected',
        workState: 'offline',
        statusText: 'Offline',
        updatedAt: Date.now(),
      };
      this.emitState();
      if (wasUp) {
        this.emit('event', {
          level: 'warn',
          type: 'disconnected',
          message: 'Disconnected from Elegoo CC2 broker',
        });
      }
    });
  }

  disconnect(): void {
    this.clearTimers();
    this.discardClient();
    this.connected = false;
    this.brokerConnected = false;
    this.rejected = false;
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
    this.ensureConnected();
    this.sendCommand(1020, { filename, storage_media: 'local' });
  }

  async pause(): Promise<void> {
    this.ensureConnected();
    this.sendCommand(1021, {});
  }

  async resume(): Promise<void> {
    this.ensureConnected();
    this.sendCommand(1023, {});
  }

  async stop(): Promise<void> {
    this.ensureConnected();
    this.sendCommand(1022, {});
  }

  async emergencyStop(): Promise<void> {
    this.ensureConnected();
    this.sendCommand(1007, {});
  }

  async setTemperature(target: { nozzle?: number; bed?: number }): Promise<void> {
    this.ensureConnected();
    const params: Record<string, number> = {};
    if (target.nozzle !== undefined) {
      if (target.nozzle < 0 || target.nozzle > MAX_NOZZLE_TEMP) {
        throw new Error(`Nozzle temperature out of safe range (0-${MAX_NOZZLE_TEMP}°C)`);
      }
      params.extruder = Math.round(target.nozzle);
    }
    if (target.bed !== undefined) {
      if (target.bed < 0 || target.bed > MAX_BED_TEMP) {
        throw new Error(`Bed temperature out of safe range (0-${MAX_BED_TEMP}°C)`);
      }
      params.heater_bed = Math.round(target.bed);
    }
    if (Object.keys(params).length > 0) {
      this.sendCommand(1028, params);
    }
  }

  async home(axes = 'XYZ'): Promise<void> {
    this.ensureConnected();
    this.sendCommand(1026, { axes });
  }

  async setLight(on: boolean): Promise<void> {
    this.ensureConnected();
    this.sendCommand(1029, { status: on ? 1 : 0 });
  }

  async move(axis: 'x' | 'y' | 'z', deltaMm: number): Promise<void> {
    this.ensureConnected();
    const clamped = Math.max(-50, Math.min(50, deltaMm));
    this.sendCommand(1027, { axis: axis.toUpperCase(), step: clamped });
  }

  async setFan(fan: 'model' | 'aux' | 'case', speedPercent: number): Promise<void> {
    this.ensureConnected();
    const key = fan === 'model' ? 'fan' : fan === 'aux' ? 'aux_fan' : 'box_fan';
    const pct = Math.max(0, Math.min(100, Math.round(speedPercent)));
    this.sendCommand(1030, { [key]: pct });
  }

  async setSpeedMode(mode: 50 | 100 | 130 | 160): Promise<void> {
    this.ensureConnected();
    const modeIndex = mode === 50 ? 0 : mode === 100 ? 1 : mode === 130 ? 2 : 3;
    this.sendCommand(1031, { mode: modeIndex });
  }

  async runMaintenance(task: 'self_check' | 'auto_level' | 'vibration' | 'pid'): Promise<void> {
    this.ensureConnected();
    const methodMap = {
      auto_level: 1032,
      vibration: 1033,
      pid: 1034,
      self_check: 1035,
    } as const;
    this.sendCommand(methodMap[task], {});
  }

  async filamentOp(op: 'load' | 'unload'): Promise<void> {
    this.ensureConnected();
    this.sendCommand(op === 'load' ? 1024 : 1025, {});
  }

  /**
   * Wakes up the CC2 MJPEG video stream via SDCP WebSocket (port 3030),
   * matching the official Elegoo client handshake.
   */
  enableVideoStreamSDCP(): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
    const url = `ws://${this.ip}:3030/websocket`;
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { handshakeTimeout: 5000 });
      } catch (err) {
        resolve({ success: false, error: (err as Error).message });
        return;
      }
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve({ success: false, error: 'Timed out after 10s' });
      }, 10_000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            Id: '',
            Topic: '',
            Data: {
              Cmd: 386,
              Data: { Enable: 1 },
              MainboardID: '',
              RequestID: randomBytes(13).toString('hex'),
              TimeStamp: Math.floor(Date.now() / 1000),
              From: 2,
            },
          }),
        );
      });

      ws.on('message', (raw: Buffer) => {
        clearTimeout(timeout);
        try {
          const resp = JSON.parse(raw.toString()) as Record<string, Record<string, Record<string, unknown>>>;
          const ack = resp?.Data?.Data?.Ack ?? resp?.Data?.Ack;
          const videoUrl = resp?.Data?.Data?.VideoUrl ?? resp?.Data?.VideoUrl;
          resolve(
            ack === 0
              ? { success: true, videoUrl: typeof videoUrl === 'string' ? videoUrl : undefined }
              : { success: false, error: `Ack=${String(ack)}` },
          );
        } catch {
          resolve({ success: false, error: 'Non-JSON response' });
        }
        ws.close();
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });

      ws.on('close', () => clearTimeout(timeout));
    });
  }

  private ensureConnected(): void {
    if (!this.connected || !this.client || !this.sn) {
      throw new Error(`Printer ${this.printerId} is not connected`);
    }
  }

  private sendCommand(method: number, params: Record<string, unknown>): void {
    if (!this.client || !this.sn) return;
    this.commandId++;
    const topic = `elegoo/${this.sn}/${this.clientId}/api_request`;
    this.client.publish(topic, JSON.stringify({ id: this.commandId, method, params }));
  }

  private register(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/${this.requestId}/register_response`, { qos: 1 });
    this.sendRegister();
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.registerTimer = setInterval(() => {
      if (this.connected) {
        if (this.registerTimer) clearInterval(this.registerTimer);
        this.registerTimer = null;
        return;
      }
      this.sendRegister();
    }, 5000);
  }

  private sendRegister(): void {
    if (!this.client || !this.sn) return;
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId }),
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatMissed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.client || !this.sn) return;
      this.heartbeatMissed++;
      if (this.heartbeatMissed >= 2) {
        this.connected = false;
        this.clearTimers();
        this.discardClient();
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        return;
      }
      this.client.publish(
        `elegoo/${this.sn}/${this.clientId}/api_request`,
        JSON.stringify({ type: 'PING' }),
      );
    }, 30_000);
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (topic.endsWith(`/${this.clientId}/api_response`)) {
      this.heartbeatMissed = 0;
    }

    if (!this.sn && topic.startsWith('elegoo/')) {
      const parts = topic.split('/');
      if (parts.length >= 3 && parts[1].length > 0) {
        this.sn = parts[1];
        this.state.serialNumber = this.sn;
        this.emit('sn', this.sn);
        this.client?.unsubscribe('elegoo/#');
        this.updateConnectionState('registering');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      if (data.error === 'ok') {
        this.connected = true;
        this.rejected = false;
        if (this.registerTimer) clearInterval(this.registerTimer);
        if (this.slowRegisterTimer) clearInterval(this.slowRegisterTimer);
        this.client?.subscribe(`elegoo/${this.sn}/api_status`, { qos: 1 });
        this.client?.subscribe(`elegoo/${this.sn}/${this.clientId}/api_response`, { qos: 1 });
        this.startHeartbeat();
        this.sendCommand(1001, {});
        this.sendCommand(1002, {});
        this.updateConnectionState('connected');
        this.emit('event', {
          level: 'info',
          type: 'connected',
          message: `Registered with Elegoo CC2 (${this.sn})`,
        });
      } else if (data.code === 3) {
        this.rejected = true;
        if (this.registerTimer) clearInterval(this.registerTimer);
        this.updateConnectionState('rejected');
        if (!this.slowRegisterTimer) {
          this.slowRegisterTimer = setInterval(() => this.sendRegister(), 30_000);
        }
      }
      return;
    }

    if (topic.includes('/api_status')) {
      const status = (data.result as Record<string, unknown> | undefined) ?? data;
      this.applyStatusDelta(status);
    } else if (topic.includes('/api_response') && data.method === 1002 && data.result) {
      this.applyStatusDelta(data.result as Record<string, unknown>);
    }
  }

  private applyStatusDelta(delta: Record<string, unknown>): void {
    const ms = delta.machine_status as Record<string, unknown> | undefined;
    const ps = delta.print_status as Record<string, unknown> | undefined;
    const ext = delta.extruder as Record<string, unknown> | undefined;
    const bed = delta.heater_bed as Record<string, unknown> | undefined;
    const chamber = delta.ztemperature_sensor as Record<string, unknown> | undefined;
    const fans = delta.fans as Record<string, Record<string, unknown>> | undefined;
    const led = delta.led as Record<string, unknown> | undefined;
    const extDev = delta.external_device as Record<string, unknown> | undefined;

    let workState: PrinterWorkState = this.state.workState;
    let statusText = this.state.statusText;
    if (ms && typeof ms.status === 'number') {
      const sub = typeof ms.sub_status === 'number' ? ms.sub_status : 0;
      const baseName = CC2_STATUS_NAMES[ms.status] ?? `Status ${ms.status}`;
      const subName = CC2_SUB_STATUS_NAMES[sub] ?? '';
      statusText = subName && subName !== baseName ? `${baseName} · ${subName}` : baseName;
      if (ms.status === 14) workState = 'estop';
      else if (ms.status === 2 && (sub === 2502 || sub === 2505)) workState = 'paused';
      else if (ms.status === 2) workState = 'printing';
      else if (ms.status === 1) workState = 'idle';
      else workState = 'busy';

      if (Array.isArray(ms.exception_status)) {
        const currentCodes = new Set<number>();
        for (const code of ms.exception_status) {
          if (typeof code === 'number' && CC2_CRITICAL_EXCEPTIONS.has(code)) {
            currentCodes.add(code);
            workState = 'error';
            if (!this.activeExceptions.has(code)) {
              const excName = CC2_EXCEPTION_NAMES[code] ?? `Exception ${code}`;
              this.emit('event', {
                level: 'error',
                type: 'hardware_exception',
                message: `CC2 fault (${code}): ${excName}`,
                payload: { code },
              });
            }
          }
        }
        this.activeExceptions = currentCodes;
      }
    }

    const prevPrint = this.state.print;
    const nextPrint =
      ps && (ps.filename || prevPrint)
        ? {
            filename: typeof ps.filename === 'string' ? ps.filename : (prevPrint?.filename ?? ''),
            progress:
              typeof ps.progress === 'number'
                ? ps.progress
                : typeof ms?.progress === 'number'
                  ? ms.progress
                  : (prevPrint?.progress ?? 0),
            currentLayer:
              typeof ps.current_layer === 'number'
                ? ps.current_layer
                : (prevPrint?.currentLayer ?? null),
            totalLayers:
              typeof ps.total_layer === 'number'
                ? ps.total_layer
                : (prevPrint?.totalLayers ?? null),
            elapsedSec:
              typeof ps.print_duration === 'number'
                ? ps.print_duration
                : (prevPrint?.elapsedSec ?? null),
            remainingSec:
              typeof ps.remaining_time_sec === 'number'
                ? ps.remaining_time_sec
                : (prevPrint?.remainingSec ?? null),
          }
        : workState === 'idle'
          ? null
          : prevPrint;

    this.state = {
      ...this.state,
      connectionState: this.connected ? 'connected' : this.state.connectionState,
      workState,
      statusText,
      temperatures: {
        nozzle: {
          actual:
            typeof ext?.temperature === 'number'
              ? ext.temperature
              : this.state.temperatures.nozzle.actual,
          target:
            typeof ext?.target === 'number' ? ext.target : this.state.temperatures.nozzle.target,
        },
        bed: {
          actual:
            typeof bed?.temperature === 'number'
              ? bed.temperature
              : this.state.temperatures.bed.actual,
          target:
            typeof bed?.target === 'number' ? bed.target : this.state.temperatures.bed.target,
        },
        chamber: {
          actual:
            typeof chamber?.temperature === 'number'
              ? chamber.temperature
              : this.state.temperatures.chamber.actual,
        },
      },
      print: nextPrint,
      fans: {
        model: typeof fans?.fan?.speed === 'number' ? fans.fan.speed : this.state.fans.model,
        aux: typeof fans?.aux_fan?.speed === 'number' ? fans.aux_fan.speed : this.state.fans.aux,
        case: typeof fans?.box_fan?.speed === 'number' ? fans.box_fan.speed : this.state.fans.case,
      },
      lightOn: typeof led?.status === 'number' ? led.status > 0 : this.state.lightOn,
      camera: {
        ...this.state.camera,
        available:
          typeof extDev?.camera === 'boolean' ? extDev.camera : this.state.camera.available,
      },
      updatedAt: Date.now(),
    };
    this.emitState();
  }

  private updateConnectionState(connectionState: UnifiedPrinterState['connectionState']): void {
    this.state = {
      ...this.state,
      connectionState,
      workState: connectionState === 'connected' ? this.state.workState : 'offline',
      updatedAt: Date.now(),
    };
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.state);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }
    if (this.slowRegisterTimer) {
      clearInterval(this.slowRegisterTimer);
      this.slowRegisterTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private discardClient(): void {
    const client = this.client;
    if (!client) return;
    this.client = null;
    client.removeAllListeners();
    // Keep no-op error listener: mqtt.js can still emit connack timeout after end(true).
    client.on('error', () => {});
    client.end(true);
  }
}
