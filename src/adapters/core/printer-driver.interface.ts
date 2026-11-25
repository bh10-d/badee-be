import type { EventEmitter } from 'events';

export type PrinterBrand = 'elegoo' | 'anycubic';

export type PrinterConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'awaiting_sn'
  | 'registering'
  | 'rejected'
  | 'connected';

export type PrinterWorkState =
  | 'offline'
  | 'idle'
  | 'printing'
  | 'paused'
  | 'busy'
  | 'error'
  | 'estop';

export interface UnifiedPrinterState {
  printerId: string;
  brand: PrinterBrand;
  model: string;
  ip: string;
  serialNumber: string | null;
  connectionState: PrinterConnectionState;
  workState: PrinterWorkState;
  statusText: string;
  temperatures: {
    nozzle: { actual: number; target: number };
    bed: { actual: number; target: number };
    chamber: { actual: number | null };
  };
  print: {
    filename: string;
    progress: number;
    currentLayer: number | null;
    totalLayers: number | null;
    elapsedSec: number | null;
    remainingSec: number | null;
  } | null;
  fans: {
    model: number | null;
    aux: number | null;
    case: number | null;
  };
  lightOn: boolean | null;
  camera: {
    available: boolean;
    streamUrl: string | null;
    protocol: 'mjpeg' | 'flv' | 'webrtc' | 'none';
  };
  filamentSlots?: Array<{
    slot: number;
    material: string;
    colorHex: string;
    status: 'empty' | 'loaded' | 'active';
  }>;
  updatedAt: number;
}

export interface PrinterCapabilities {
  pause: boolean;
  resume: boolean;
  stop: boolean;
  emergencyStop: boolean;
  setTemperature: boolean;
  home: boolean;
  light: boolean;
  camera: boolean;
  multiMaterial: boolean;
}

export interface DriverEvent {
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface DriverInitConfig {
  printerId: string;
  brand: PrinterBrand;
  model: string;
  ip: string;
  serialNumber?: string | null;
  cameraUrl?: string | null;
  credentials: Record<string, unknown>;
}

export interface IPrinterDriver extends EventEmitter {
  readonly printerId: string;
  readonly brand: PrinterBrand;
  readonly model: string;

  connect(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  getState(): UnifiedPrinterState;
  getCapabilities(): PrinterCapabilities;

  startPrint(filename: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  emergencyStop(): Promise<void>;
  setTemperature(target: { nozzle?: number; bed?: number }): Promise<void>;
  home(axes?: string): Promise<void>;
  setLight(on: boolean): Promise<void>;
  move?(axis: 'x' | 'y' | 'z', deltaMm: number): Promise<void>;
  setFan?(fan: 'model' | 'aux' | 'case', speedPercent: number): Promise<void>;
  setSpeedMode?(mode: 50 | 100 | 130 | 160): Promise<void>;
  runMaintenance?(task: 'self_check' | 'auto_level' | 'vibration' | 'pid'): Promise<void>;
  filamentOp?(op: 'load' | 'unload'): Promise<void>;
}

export interface IBrandAdapter {
  readonly brand: PrinterBrand;
  readonly supportedModels: readonly string[];
  createDriver(config: DriverInitConfig): IPrinterDriver;
}
