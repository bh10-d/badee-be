import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BedStatus, PrinterBrand, PrinterMode } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { PrinterRegistryService } from '../adapters/core/printer-registry.service';
import { LanDiscoveryService } from '../adapters/discovery/lan-discovery.service';
import { GcodeValidatorService } from '../rentals/gcode-validator.service';
import { RentalPolicyService } from '../rentals/rental-policy.service';
import type { AuthTokenPayload } from '../auth/token.util';
import { getEnv } from '../config/env';
import { encryptCredentials } from '../common/crypto.util';
import { isAllowedPrinterIp, validateCameraUrlForPrinter } from '../common/network.util';

export const createPrinterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brand: z.enum(['elegoo', 'anycubic']),
  model: z.string().trim().min(1).max(40),
  ip: z.string().trim().min(7).max(45),
  cameraUrl: z.string().trim().max(255).optional().nullable(),
  mode: z.enum(['pool', 'rental', 'maintenance']).optional().default('pool'),
  isEnabled: z.boolean().optional().default(true),
  credentials: z.record(z.string(), z.unknown()).optional().default({}),
});

export const updatePrinterSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  ip: z.string().trim().min(7).max(45).optional(),
  cameraUrl: z.string().trim().max(255).optional().nullable(),
  mode: z.enum(['pool', 'rental', 'maintenance']).optional(),
  bedStatus: z.enum(['clean', 'dirty', 'unknown']).optional(),
  isEnabled: z.boolean().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

export const printerCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('emergency_stop') }),
  z.object({ action: z.literal('home'), axes: z.string().max(8).optional() }),
  z.object({ action: z.literal('light'), on: z.boolean() }),
  z.object({
    action: z.literal('temperature'),
    nozzle: z.number().min(0).max(300).optional(),
    bed: z.number().min(0).max(110).optional(),
  }),
  z.object({
    action: z.literal('move'),
    axis: z.enum(['x', 'y', 'z']),
    deltaMm: z.number().min(-50).max(50),
  }),
  z.object({
    action: z.literal('fan'),
    fan: z.enum(['model', 'aux', 'case']),
    speedPercent: z.number().min(0).max(100),
  }),
  z.object({
    action: z.literal('speed_mode'),
    mode: z.union([z.literal(50), z.literal(100), z.literal(130), z.literal(160)]),
  }),
  z.object({
    action: z.literal('maintenance'),
    task: z.enum(['self_check', 'auto_level', 'vibration', 'pid']),
  }),
  z.object({
    action: z.literal('filament'),
    op: z.enum(['load', 'unload']),
  }),
]);

export type CreatePrinterDto = z.infer<typeof createPrinterSchema>;
export type UpdatePrinterDto = z.infer<typeof updatePrinterSchema>;
export type PrinterCommandDto = z.infer<typeof printerCommandSchema>;

/** Explicit safe projection — credentialsEncrypted is NEVER selected for list/detail responses. */
const SAFE_PRINTER_SELECT = {
  id: true,
  name: true,
  brand: true,
  model: true,
  ip: true,
  serialNumber: true,
  cameraUrl: true,
  mode: true,
  bedStatus: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class PrintersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PrinterRegistryService,
    private readonly discovery: LanDiscoveryService,
    private readonly rentalPolicy: RentalPolicyService,
    private readonly gcodeValidator: GcodeValidatorService,
  ) {}

  async discoverLanPrinters(raw: unknown) {
    const schema = z
      .object({
        subnet: z.string().trim().max(32).optional(),
        timeoutMs: z.number().int().min(1000).max(5000).optional(),
      })
      .optional();
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }

    let result;
    try {
      result = await this.discovery.scan(parsed.data ?? {});
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // Cross-reference discovered printers against PostgreSQL in 1 single query (zero N+1)
    const existing = await this.prisma.printer.findMany({
      select: { id: true, ip: true, serialNumber: true },
    });
    const byIp = new Map(existing.map((p) => [p.ip, p.id]));
    const bySn = new Map(
      existing.filter((p) => p.serialNumber).map((p) => [p.serialNumber!, p.id]),
    );

    return {
      scannedSubnets: result.scannedSubnets,
      durationMs: result.durationMs,
      printers: result.printers.map((p) => {
        const existingPrinterId =
          byIp.get(p.ip) ?? (p.serialNumber ? bySn.get(p.serialNumber) : undefined) ?? null;
        return {
          ...p,
          alreadyRegistered: existingPrinterId !== null,
          existingPrinterId,
        };
      }),
    };
  }

  getCatalog() {
    return this.registry.getSupportedCatalog();
  }

  async findAll(user: AuthTokenPayload) {
    let allowedIds: string[] | undefined;
    if (user.role === 'renter') {
      allowedIds = await this.rentalPolicy.getActivePrinterIdsForRenter(user.sub);
      if (allowedIds.length === 0) return [];
    }

    // Single query with aggregated queued job count — zero N+1 queries.
    const rows = await this.prisma.printer.findMany({
      where: allowedIds ? { id: { in: allowedIds } } : undefined,
      select: {
        ...SAFE_PRINTER_SELECT,
        _count: {
          select: {
            jobs: { where: { status: 'queued' } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const liveStates = this.registry.getAllStates();
    return rows.map((row) => ({
      ...row,
      queuedJobs: row._count.jobs,
      _count: undefined,
      live: liveStates.get(row.id) ?? null,
      capabilities: this.registry.getDriver(row.id)?.getCapabilities() ?? null,
    }));
  }

  async findOne(id: string, user: AuthTokenPayload) {
    let renterSince: Date | null = null;
    if (user.role === 'renter') {
      const session = await this.rentalPolicy.getActiveSessionForRenterPrinter(user.sub, id);
      if (!session) {
        throw new ForbiddenException('You do not have an active rental session for this printer');
      }
      renterSince = session.startsAt;
    }
    // Single query fetching printer + tenant-scoped events & jobs (no N+1, no cross-tenant leak).
    const row = await this.prisma.printer.findUnique({
      where: { id },
      select: {
        ...SAFE_PRINTER_SELECT,
        events: {
          where: renterSince ? { createdAt: { gte: renterSince } } : undefined,
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            level: true,
            type: true,
            message: true,
            createdAt: true,
          },
        },
        jobs:
          user.role === 'renter'
            ? false
            : {
                where: { status: { in: ['queued', 'dispatched', 'printing', 'paused'] } },
                orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
                take: 20,
                select: {
                  id: true,
                  filename: true,
                  status: true,
                  priority: true,
                  estimatedSec: true,
                  filamentGrams: true,
                  createdAt: true,
                },
              },
      },
    });

    if (!row) throw new NotFoundException(`Printer ${id} not found`);

    return {
      ...row,
      live: this.registry.getState(row.id),
      capabilities: this.registry.getDriver(row.id)?.getCapabilities() ?? null,
    };
  }

  async create(raw: unknown) {
    const parsed = createPrinterSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const dto = parsed.data;

    if (!this.registry.isSupported(dto.brand, dto.model)) {
      throw new BadRequestException(`Unsupported model "${dto.model}" for brand "${dto.brand}"`);
    }
    if (!isAllowedPrinterIp(dto.ip)) {
      throw new BadRequestException(
        'Invalid or disallowed IPv4 address (loopback/metadata/multicast blocked)',
      );
    }

    let safeCameraUrl: string | null = null;
    try {
      safeCameraUrl = validateCameraUrlForPrinter(dto.cameraUrl, dto.ip);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const existing = await this.prisma.printer.findUnique({
      where: { ip: dto.ip },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`A printer with IP ${dto.ip} already exists`);
    }

    const credentialsEncrypted =
      Object.keys(dto.credentials).length > 0
        ? encryptCredentials(dto.credentials, getEnv().CREDENTIALS_ENCRYPTION_KEY)
        : null;

    const created = await this.prisma.printer.create({
      data: {
        name: dto.name,
        brand: dto.brand as PrinterBrand,
        model: dto.model.toLowerCase(),
        ip: dto.ip,
        cameraUrl: safeCameraUrl,
        mode: dto.mode as PrinterMode,
        isEnabled: dto.isEnabled,
        credentialsEncrypted,
      },
    });

    this.registry.registerAndConnect(created);

    const { credentialsEncrypted: _hidden, ...safe } = created;
    return { ...safe, live: this.registry.getState(created.id) };
  }

  async update(id: string, raw: unknown) {
    const parsed = updatePrinterSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const dto = parsed.data;

    const existing = await this.prisma.printer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Printer ${id} not found`);

    const nextIp = dto.ip ?? existing.ip;
    if (dto.ip) {
      if (!isAllowedPrinterIp(dto.ip)) {
        throw new BadRequestException('Invalid or disallowed IPv4 address');
      }
      if (dto.ip !== existing.ip) {
        const conflict = await this.prisma.printer.findUnique({
          where: { ip: dto.ip },
          select: { id: true },
        });
        if (conflict) {
          throw new ConflictException(`A printer with IP ${dto.ip} already exists`);
        }
      }
    }

    let nextCameraUrl = existing.cameraUrl;
    if (dto.cameraUrl !== undefined) {
      try {
        nextCameraUrl = validateCameraUrlForPrinter(dto.cameraUrl, nextIp);
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
    }

    const credentialsEncrypted = dto.credentials
      ? encryptCredentials(dto.credentials, getEnv().CREDENTIALS_ENCRYPTION_KEY)
      : undefined;

    const updated = await this.prisma.printer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.ip !== undefined ? { ip: dto.ip } : {}),
        ...(dto.cameraUrl !== undefined ? { cameraUrl: nextCameraUrl } : {}),
        ...(dto.mode !== undefined ? { mode: dto.mode as PrinterMode } : {}),
        ...(dto.bedStatus !== undefined ? { bedStatus: dto.bedStatus as BedStatus } : {}),
        ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        ...(credentialsEncrypted !== undefined ? { credentialsEncrypted } : {}),
      },
    });

    // Reconnect only when connection-relevant fields changed
    if (
      dto.ip !== undefined ||
      dto.cameraUrl !== undefined ||
      dto.isEnabled !== undefined ||
      dto.credentials !== undefined
    ) {
      this.registry.registerAndConnect(updated);
    }

    const { credentialsEncrypted: _hidden, ...safe } = updated;
    return { ...safe, live: this.registry.getState(updated.id) };
  }

  async confirmBedClear(id: string) {
    const existing = await this.prisma.printer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Printer ${id} not found`);

    const updated = await this.prisma.printer.update({
      where: { id },
      data: { bedStatus: 'clean' },
      select: SAFE_PRINTER_SELECT,
    });
    await this.prisma.printerEvent.create({
      data: {
        printerId: id,
        level: 'info',
        type: 'bed_cleared',
        message: 'Operator confirmed print bed is clear',
      },
    });
    return updated;
  }

  async remove(id: string) {
    const existing = await this.prisma.printer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Printer ${id} not found`);

    this.registry.unregister(id);
    await this.prisma.printer.delete({ where: { id } });
    return { deleted: true, id };
  }

  async sendCommand(id: string, raw: unknown, user: AuthTokenPayload) {
    const parsed = printerCommandSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const cmd = parsed.data;

    if (user.role === 'renter') {
      await this.rentalPolicy.assertRenterCanCommand(user.sub, id, cmd);
    }

    const driver = this.registry.getDriver(id);
    if (!driver) {
      throw new NotFoundException(`No active driver for printer ${id}`);
    }

    switch (cmd.action) {
      case 'pause':
        await driver.pause();
        break;
      case 'resume':
        await driver.resume();
        break;
      case 'stop':
        await driver.stop();
        break;
      case 'emergency_stop':
        await driver.emergencyStop();
        break;
      case 'home':
        await driver.home(cmd.axes);
        break;
      case 'light':
        await driver.setLight(cmd.on);
        break;
      case 'temperature':
        await driver.setTemperature({ nozzle: cmd.nozzle, bed: cmd.bed });
        break;
      case 'move':
        if (!driver.move) throw new BadRequestException('Axis jog not supported by this driver');
        await driver.move(cmd.axis, cmd.deltaMm);
        break;
      case 'fan':
        if (!driver.setFan) throw new BadRequestException('Fan control not supported by this driver');
        await driver.setFan(cmd.fan, cmd.speedPercent);
        break;
      case 'speed_mode':
        if (!driver.setSpeedMode) {
          throw new BadRequestException('Speed mode not supported by this driver');
        }
        await driver.setSpeedMode(cmd.mode);
        break;
      case 'maintenance':
        if (!driver.runMaintenance) {
          throw new BadRequestException('Maintenance routines not supported by this driver');
        }
        await driver.runMaintenance(cmd.task);
        break;
      case 'filament':
        if (!driver.filamentOp) {
          throw new BadRequestException('Filament load/unload not supported by this driver');
        }
        await driver.filamentOp(cmd.op);
        break;
    }

    await this.prisma.printerEvent.create({
      data: {
        printerId: id,
        level: cmd.action === 'emergency_stop' ? 'warn' : 'info',
        type: `cmd_${cmd.action}`,
        message: `Command dispatched: ${cmd.action}`,
      },
    });

    return { ok: true, action: cmd.action };
  }

  async validateGcode(id: string, raw: unknown, user: AuthTokenPayload) {
    const schema = z.object({
      filename: z.string().trim().min(1).max(255),
      gcodeText: z.string().min(1).max(10 * 1024 * 1024, 'G-code payload exceeds 10MB validation limit'),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }

    const printer = await this.prisma.printer.findUnique({
      where: { id },
      select: { id: true, brand: true, model: true },
    });
    if (!printer) throw new NotFoundException(`Printer ${id} not found`);

    let maxNozzleTemp = 300;
    let maxBedTemp = 110;
    let remainingRentalSec: number | null = null;

    if (user.role === 'renter') {
      const session = await this.rentalPolicy.getActiveSessionForRenterPrinter(user.sub, id);
      if (!session) {
        throw new ForbiddenException('You do not have an active rental session for this printer');
      }
      maxNozzleTemp = session.maxNozzleTemp;
      maxBedTemp = session.maxBedTemp;
      remainingRentalSec = Math.max(0, Math.floor((session.endsAt.getTime() - Date.now()) / 1000));
    }

    const buildVolume =
      printer.brand === 'elegoo' && printer.model === 'cc2'
        ? { x: 256, y: 256, z: 256 }
        : { x: 250, y: 250, z: 260 };

    return this.gcodeValidator.validate(parsed.data.gcodeText, {
      maxNozzleTemp,
      maxBedTemp,
      buildVolume,
      remainingRentalSec,
    });
  }

  /**
   * Resolves & authorizes the upstream LAN camera stream URL for a printer
   * so the controller can proxy MJPEG/FLV safely without exposing LAN IPs or hitting CORS.
   */
  async resolveCameraStream(
    id: string,
    user: AuthTokenPayload,
  ): Promise<{ streamUrl: string; protocol: 'mjpeg' | 'flv' | 'webrtc' | 'none' }> {
    const printer = await this.prisma.printer.findUnique({
      where: { id },
      select: { id: true, ip: true, cameraUrl: true, isEnabled: true },
    });
    if (!printer || !printer.isEnabled) {
      throw new NotFoundException(`Printer ${id} not found or disabled`);
    }

    if (user.role === 'renter') {
      const session = await this.rentalPolicy.getActiveSessionForRenterPrinter(user.sub, id);
      if (!session) {
        throw new ForbiddenException('You do not have an active rental session for this printer');
      }
    }

    const live = this.registry.getState(id);
    const streamUrl = live?.camera.streamUrl ?? printer.cameraUrl;
    const protocol = live?.camera.protocol ?? 'mjpeg';
    if (!streamUrl) {
      throw new NotFoundException('Camera stream is unavailable for this printer');
    }

    // Strict SSRF check: upstream URL must target the printer's own IP
    const safeUrl = validateCameraUrlForPrinter(streamUrl, printer.ip);
    if (!safeUrl) {
      throw new BadRequestException('Invalid camera stream URL');
    }

    return { streamUrl: safeUrl, protocol };
  }
}
