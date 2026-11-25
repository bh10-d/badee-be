import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import type { Printer } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { getEnv } from '../../config/env';
import { decryptCredentials } from '../../common/crypto.util';
import { ElegooAdapter } from '../elegoo/elegoo.adapter';
import { AnycubicAdapter } from '../anycubic/anycubic.adapter';
import type {
  DriverEvent,
  IBrandAdapter,
  IPrinterDriver,
  PrinterBrand,
  UnifiedPrinterState,
} from './printer-driver.interface';

@Injectable()
export class PrinterRegistryService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrinterRegistryService.name);
  private readonly adapters = new Map<PrinterBrand, IBrandAdapter>();
  private readonly drivers = new Map<string, IPrinterDriver>();

  constructor(
    private readonly prisma: PrismaService,
    elegoo: ElegooAdapter,
    anycubic: AnycubicAdapter,
  ) {
    super();
    this.adapters.set(elegoo.brand, elegoo);
    this.adapters.set(anycubic.brand, anycubic);
  }

  getSupportedCatalog(): Record<PrinterBrand, readonly string[]> {
    const catalog = {} as Record<PrinterBrand, readonly string[]>;
    for (const [brand, adapter] of this.adapters.entries()) {
      catalog[brand] = adapter.supportedModels;
    }
    return catalog;
  }

  isSupported(brand: PrinterBrand, model: string): boolean {
    const adapter = this.adapters.get(brand);
    return Boolean(adapter && adapter.supportedModels.includes(model.toLowerCase()));
  }

  async onModuleInit(): Promise<void> {
    // Single query to load all enabled printers (avoids N+1 startup queries)
    const printers = await this.prisma.printer.findMany({
      where: { isEnabled: true },
      orderBy: { createdAt: 'asc' },
    });
    this.logger.log(`Initializing ${printers.length} enabled printer driver(s)`);
    for (const p of printers) {
      this.registerAndConnect(p);
    }
  }

  onModuleDestroy(): void {
    for (const driver of this.drivers.values()) {
      void driver.disconnect();
    }
    this.drivers.clear();
  }

  registerAndConnect(printer: Printer): void {
    this.unregister(printer.id);
    if (!printer.isEnabled) return;

    const adapter = this.adapters.get(printer.brand as PrinterBrand);
    if (!adapter) {
      this.logger.warn(`No adapter registered for brand "${printer.brand}"`);
      return;
    }

    let credentials: Record<string, unknown> = {};
    try {
      credentials = decryptCredentials(
        printer.credentialsEncrypted,
        getEnv().CREDENTIALS_ENCRYPTION_KEY,
      );
    } catch (err) {
      this.logger.error(
        `Failed to decrypt credentials for printer ${printer.id}: ${(err as Error).message}`,
      );
      return;
    }

    const driver = adapter.createDriver({
      printerId: printer.id,
      brand: printer.brand as PrinterBrand,
      model: printer.model,
      ip: printer.ip,
      serialNumber: printer.serialNumber,
      cameraUrl: printer.cameraUrl,
      credentials,
    });

    driver.on('state', (state: UnifiedPrinterState) => {
      this.emit('state', state);
    });

    driver.on('sn', (sn: string) => {
      void this.prisma.printer
        .update({ where: { id: printer.id }, data: { serialNumber: sn } })
        .catch((err: Error) =>
          this.logger.warn(`Failed to persist SN for ${printer.id}: ${err.message}`),
        );
    });

    driver.on('event', (ev: DriverEvent) => {
      this.emit('event', { printerId: printer.id, ...ev });
      void this.prisma.printerEvent
        .create({
          data: {
            printerId: printer.id,
            level: ev.level,
            type: ev.type,
            message: ev.message.slice(0, 512),
            payload: (ev.payload as object | undefined) ?? undefined,
          },
        })
        .catch((err: Error) =>
          this.logger.warn(`Failed to persist event for ${printer.id}: ${err.message}`),
        );
    });

    this.drivers.set(printer.id, driver);
    void driver.connect();
  }

  unregister(printerId: string): void {
    const existing = this.drivers.get(printerId);
    if (!existing) return;
    existing.removeAllListeners();
    void existing.disconnect();
    this.drivers.delete(printerId);
  }

  getDriver(printerId: string): IPrinterDriver | undefined {
    return this.drivers.get(printerId);
  }

  getState(printerId: string): UnifiedPrinterState | null {
    return this.drivers.get(printerId)?.getState() ?? null;
  }

  getAllStates(): Map<string, UnifiedPrinterState> {
    const map = new Map<string, UnifiedPrinterState>();
    for (const [id, driver] of this.drivers.entries()) {
      map.set(id, driver.getState());
    }
    return map;
  }
}
