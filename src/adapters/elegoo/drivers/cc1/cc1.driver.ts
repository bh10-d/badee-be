import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { WebSocket, type RawData } from 'ws';
import type {
  DriverInitConfig,
  IPrinterDriver,
  PrinterCapabilities,
  PrinterWorkState,
  UnifiedPrinterState,
} from '../../../core/printer-driver.interface';

const MAX_NOZZLE_TEMP = 300;
const MAX_BED_TEMP = 110;

const SDCP_STATUS_MAP: Record<number, { work: PrinterWorkState; text: string }> = {
  0: { work: 'idle', text: 'Idle' },
  1: { work: 'busy', text: 'Homing' },
  2: { work: 'busy', text: 'Dropping' },
  3: { work: 'printing', text: 'Printing' },
  4: { work: 'busy', text: 'Lifting' },
  5: { work: 'paused', text: 'Pausing' },
  6: { work: 'paused', text: 'Paused' },
  7: { work: 'busy', text: 'Stopping' },
  8: { work: 'idle', text: 'Stopped' },
  9: { work: 'idle', text: 'Complete' },
  10: { work: 'busy', text: 'File Checking' },
  13: { work: 'printing', text: 'Printing' },
  16: { work: 'busy', text: 'Heating' },
  19: { work: 'busy', text: 'Calibrating' },
  20: { work: 'busy', text: 'Bed Leveling' },
};

/**
 * Elegoo Centauri Carbon (CC1) driver — SDCP v3 over WebSocket (`ws://<ip>:3030/websocket`).
 * Distinct from CC2 (which uses MQTT `:1883`).
 */
export class ElegooCc1Driver extends EventEmitter implements IPrinterDriver {
  readonly printerId: string;
  readonly brand = 'elegoo' as const;
  readonly model = 'cc1';

  private readonly ip: string;
  private readonly cameraOverride: string | null;
  private sn: string;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private state: UnifiedPrinterState;

  constructor(config: DriverInitConfig) {
    super();
    this.printerId = config.printerId;
    this.ip = config.ip;
    this.sn = config.serialNumber ?? '';
    this.cameraOverride = config.cameraUrl ?? null;

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
        available: true,
        streamUrl: this.cameraOverride || `http://${this.ip}:3031/video`,
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
      multiMaterial: false,
    };
  }

  connect(): void {
    this.stopped = false;
    this.clearTimers();
    this.discardSocket();
    this.setConnectionState('connecting');

    const url = `ws://${this.ip}:3030/websocket`;
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped) {
        ws.close();
        return;
      }
      this.setConnectionState('connected');
      this.state.workState = 'idle';
      this.state.statusText = 'Idle';
      this.emitState();

      // Request initial status (Cmd: 0), attributes (Cmd: 1), and enable MJPEG camera stream (Cmd: 386)
      this.sendSdcp(0, {});
      this.sendSdcp(1, {});
      this.sendSdcp(386, { Enable: 1 });

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send('ping');
        }
      }, 15_000);

      this.statusTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendSdcp(0, {});
        }
      }, 5_000);
    });

    ws.on('message', (raw: RawData) => {
      const text = raw.toString('utf8').trim();
      if (!text || text === 'pong') return;
      this.handleMessage(text);
    });

    ws.on('error', (err: Error) => {
      this.emit('event', {
        level: 'warn',
        type: 'sdcp_ws_error',
        message: `SDCP WebSocket (${this.ip}:3030) error: ${err.message}`,
      });
    });

    ws.on('close', () => {
      this.clearTimers();
      if (!this.stopped) {
        this.state.workState = 'offline';
        this.state.statusText = 'Offline';
        this.setConnectionState('disconnected');
        this.scheduleReconnect();
      }
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.discardSocket();
    this.state.workState = 'offline';
    this.state.statusText = 'Offline';
    this.setConnectionState('disconnected');
  }

  async pause(): Promise<void> {
    this.sendSdcp(129, {});
  }

  async resume(): Promise<void> {
    this.sendSdcp(131, {});
  }

  async stop(): Promise<void> {
    this.sendSdcp(130, {});
  }

  async emergencyStop(): Promise<void> {
    this.sendSdcp(130, {});
  }

  async setTemperature(opts: { nozzle?: number; bed?: number }): Promise<void> {
    const data: Record<string, number> = {};
    if (opts.nozzle !== undefined) {
      data.TempTargetNozzle = Math.max(0, Math.min(MAX_NOZZLE_TEMP, Math.round(opts.nozzle)));
    }
    if (opts.bed !== undefined) {
      data.TempTargetHotbed = Math.max(0, Math.min(MAX_BED_TEMP, Math.round(opts.bed)));
    }
    if (Object.keys(data).length > 0) {
      this.sendSdcp(403, data);
    }
  }

  async setLight(on: boolean): Promise<void> {
    this.sendSdcp(403, { LightStatus: { SecondLight: on, RgbLight: [0, 0, 0] } });
    this.state.lightOn = on;
    this.emitState();
  }

  async setSpeedMode(mode: 50 | 100 | 130 | 160): Promise<void> {
    this.sendSdcp(403, { PrintSpeedPct: mode });
  }

  async home(axes: 'all' | 'xy' | 'z' = 'all'): Promise<void> {
    const axis = axes === 'xy' ? 'XY' : axes === 'z' ? 'Z' : 'XYZ';
    this.sendSdcp(402, { Axis: axis });
  }

  async move(axis: 'x' | 'y' | 'z', deltaMm: number): Promise<void> {
    const clamped = Math.max(-100, Math.min(100, deltaMm));
    this.sendSdcp(401, { Axis: axis.toUpperCase(), Step: clamped });
  }

  async setFan(fan: 'model' | 'aux' | 'case', speedPercent: number): Promise<void> {
    const pct = Math.max(0, Math.min(100, Math.round(speedPercent)));
    const key = fan === 'model' ? 'ModelFan' : fan === 'aux' ? 'AuxiliaryFan' : 'BoxFan';
    this.sendSdcp(403, { TargetFanSpeed: { [key]: pct } });
  }

  async startPrint(filename: string): Promise<void> {
    this.sendSdcp(128, { Filename: filename, StartLayer: 0, Calibration_switch: 1, PrintPlatformType: 0 });
  }

  private sendSdcp(cmd: number, data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Elegoo CC1 (${this.ip}) is not connected`);
    }
    const payload = {
      Id: this.sn || '',
      Data: {
        Cmd: cmd,
        Data: data,
        RequestID: randomUUID().replace(/-/g, '').slice(0, 16),
        MainboardID: this.sn,
        TimeStamp: Math.floor(Date.now() / 1000),
        From: 0,
      },
      Topic: `sdcp/request/${this.sn}`,
    };
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const topicStr = typeof msg.Topic === 'string' ? msg.Topic : '';
    const topicId = topicStr.startsWith('sdcp/') ? topicStr.split('/')[2] ?? '' : '';
    const mainboardId =
      (typeof msg.MainboardID === 'string' && msg.MainboardID) ||
      (typeof (msg.Attributes as Record<string, unknown> | undefined)?.MainboardID === 'string'
        ? String((msg.Attributes as Record<string, unknown>).MainboardID)
        : '') ||
      topicId;
    if (mainboardId && mainboardId !== this.sn) {
      this.sn = mainboardId;
      this.state.serialNumber = mainboardId;
      this.emit('sn', mainboardId);
    }

    const status = msg.Status as Record<string, unknown> | undefined;
    if (!status || typeof status !== 'object') return;

    if (typeof status.TempOfNozzle === 'number') {
      this.state.temperatures.nozzle.actual = Math.round(status.TempOfNozzle * 10) / 10;
    }
    if (typeof status.TempTargetNozzle === 'number') {
      this.state.temperatures.nozzle.target = Math.round(status.TempTargetNozzle);
    }
    if (typeof status.TempOfHotbed === 'number') {
      this.state.temperatures.bed.actual = Math.round(status.TempOfHotbed * 10) / 10;
    }
    if (typeof status.TempTargetHotbed === 'number') {
      this.state.temperatures.bed.target = Math.round(status.TempTargetHotbed);
    }
    if (typeof status.TempOfBox === 'number') {
      this.state.temperatures.chamber.actual = Math.round(status.TempOfBox * 10) / 10;
    }

    const curStatusArr = Array.isArray(status.CurrentStatus) ? status.CurrentStatus : [];
    const primaryCode = typeof curStatusArr[0] === 'number' ? curStatusArr[0] : 0;
    const mapped = SDCP_STATUS_MAP[primaryCode] ?? { work: 'idle', text: `Status ${primaryCode}` };
    this.state.workState = mapped.work;
    this.state.statusText = mapped.text;

    const lightObj = status.LightStatus as Record<string, unknown> | undefined;
    if (lightObj) {
      if (typeof lightObj.SecondLight === 'boolean') {
        this.state.lightOn = lightObj.SecondLight;
      } else if (typeof lightObj.SecondLight === 'number') {
        this.state.lightOn = lightObj.SecondLight > 0;
      }
    }

    const fanObj = status.CurrentFanSpeed as Record<string, unknown> | undefined;
    if (fanObj) {
      if (typeof fanObj.ModelFan === 'number') this.state.fans.model = fanObj.ModelFan;
      if (typeof fanObj.AuxiliaryFan === 'number') this.state.fans.aux = fanObj.AuxiliaryFan;
      if (typeof fanObj.BoxFan === 'number') this.state.fans.case = fanObj.BoxFan;
    }

    const printInfo = status.PrintInfo as Record<string, unknown> | undefined;
    if (printInfo && typeof printInfo.Filename === 'string' && printInfo.Filename.length > 0) {
      const curTicks = typeof printInfo.CurrentTicks === 'number' ? printInfo.CurrentTicks : null;
      const totTicks = typeof printInfo.TotalTicks === 'number' ? printInfo.TotalTicks : null;
      this.state.print = {
        filename: printInfo.Filename,
        progress: typeof printInfo.Progress === 'number' ? printInfo.Progress : 0,
        currentLayer: typeof printInfo.CurrentLayer === 'number' ? printInfo.CurrentLayer : null,
        totalLayers: typeof printInfo.TotalLayer === 'number' ? printInfo.TotalLayer : null,
        elapsedSec: curTicks !== null ? Math.round(curTicks / 1000) : null,
        remainingSec:
          curTicks !== null && totTicks !== null && totTicks >= curTicks
            ? Math.round((totTicks - curTicks) / 1000)
            : null,
      };
    } else if (mapped.work === 'idle') {
      this.state.print = null;
    }

    this.emitState();
  }

  private setConnectionState(next: UnifiedPrinterState['connectionState']): void {
    this.state.connectionState = next;
    this.emitState();
  }

  private emitState(): void {
    this.state.updatedAt = Date.now();
    this.emit('state', { ...this.state });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, 5_000);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private discardSocket(): void {
    if (!this.ws) return;
    this.ws.removeAllListeners();
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
