import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { OrderPriority } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { PrinterRegistryService } from '../adapters/core/printer-registry.service';
import { PlateBatcherService } from './plate-batcher.service';
import { SlicerQuoteService } from './slicer-quote.service';

const SAFE_MODEL_FILE_RE = /^[A-Za-z0-9._\-\s()]+\.(stl|3mf|gcode|gco)$/i;

export const createQuoteOrderSchema = z.object({
  customerName: z.string().trim().min(2).max(100),
  customerEmail: z.string().trim().email().max(160),
  customerPhone: z.string().trim().max(32).optional(),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (f) => !f.includes('..') && !f.includes('/') && !f.includes('\\') && SAFE_MODEL_FILE_RE.test(f),
      'Filename must be a valid .stl, .3mf, or .gcode file without path segments',
    ),
  materialCode: z.string().trim().min(1).max(32),
  estimatedGrams: z.number().min(1).max(5000),
  quantity: z.number().int().min(1).max(500).default(1),
  priority: z.enum(['normal', 'express']).default('normal'),
  notes: z.string().trim().max(500).optional(),
});

const DEFAULT_MATERIALS = [
  { code: 'PLA', name: 'PLA+ Standard', pricePerGramVnd: 1200, densityGcm3: 1.24, colorHex: '#2f81f7' },
  { code: 'PETG', name: 'PETG Mechanical', pricePerGramVnd: 1500, densityGcm3: 1.27, colorHex: '#2ea043' },
  { code: 'ABS', name: 'ABS+ Engineering', pricePerGramVnd: 1700, densityGcm3: 1.04, colorHex: '#d29922' },
  { code: 'TPU', name: 'TPU 95A Flexible', pricePerGramVnd: 2200, densityGcm3: 1.21, colorHex: '#f85149' },
] as const;

@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PrinterRegistryService,
    private readonly quoteEngine: SlicerQuoteService,
    private readonly plateBatcher: PlateBatcherService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Idempotent seed of baseline materials on fresh PostgreSQL DB (single batch check)
    const count = await this.prisma.filamentMaterial.count();
    if (count === 0) {
      await this.prisma.filamentMaterial.createMany({
        data: DEFAULT_MATERIALS.map((m) => ({ ...m })),
        skipDuplicates: true,
      });
    }
  }

  /**
   * Public real-time farm capacity summary for the Next.js `/farm` page.
   * Deliberately exposes zero internal IPs, serial numbers, or customer PII.
   */
  async getPublicFarmSummary() {
    const [printersTotal, queuedJobs, activeMaterials] = await Promise.all([
      this.prisma.printer.count({ where: { isEnabled: true } }),
      this.prisma.printJob.count({ where: { status: { in: ['queued', 'dispatched', 'printing'] } } }),
      this.prisma.filamentMaterial.count({ where: { isActive: true } }),
    ]);

    const states = Array.from(this.registry.getAllStates().values());
    const online = states.filter((s) => s.connectionState === 'connected').length;
    const printing = states.filter((s) => s.workState === 'printing').length;
    const idle = states.filter((s) => s.workState === 'idle').length;

    const leadTimeDays = queuedJobs > printersTotal * 4 ? '3–5 business days' : '1–2 business days';

    return {
      printersTotal,
      printersOnline: online,
      printersPrinting: printing,
      printersIdle: idle,
      queuedJobs,
      activeMaterials,
      leadTimeNormal: leadTimeDays,
      leadTimeExpress: '24–48 hours',
      updatedAt: new Date().toISOString(),
    };
  }

  async listPublicMaterials() {
    return this.prisma.filamentMaterial.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        pricePerGramVnd: true,
        densityGcm3: true,
        colorHex: true,
      },
      orderBy: { pricePerGramVnd: 'asc' },
    });
  }

  async createQuoteOrder(raw: unknown) {
    const parsed = createQuoteOrderSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const dto = parsed.data;

    const material = await this.prisma.filamentMaterial.findUnique({
      where: { code: dto.materialCode.toUpperCase() },
    });
    if (!material || !material.isActive) {
      throw new BadRequestException(`Material "${dto.materialCode}" is unavailable`);
    }

    const quote = this.quoteEngine.calculateQuote({
      estimatedGrams: dto.estimatedGrams,
      pricePerGramVnd: material.pricePerGramVnd,
      quantity: dto.quantity,
      priority: dto.priority,
    });

    const orderCode = `PF-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex').toUpperCase()}`;

    const order = await this.prisma.printOrder.create({
      data: {
        orderCode,
        customerName: dto.customerName,
        customerEmail: dto.customerEmail,
        customerPhone: dto.customerPhone ?? null,
        filename: dto.filename,
        materialId: material.id,
        quantity: dto.quantity,
        priority: dto.priority as OrderPriority,
        estimatedGrams: quote.estimatedGrams,
        estimatedSec: quote.estimatedSec,
        unitPriceVnd: quote.unitPriceVnd,
        totalPriceVnd: quote.totalPriceVnd,
        notes: dto.notes ?? null,
      },
      include: {
        material: {
          select: { code: true, name: true, pricePerGramVnd: true },
        },
      },
    });

    return { order, breakdown: quote };
  }

  async listOrders() {
    // Single JOIN query — zero N+1.
    return this.prisma.printOrder.findMany({
      include: {
        material: {
          select: { code: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Atomically approves an On-Demand order and enqueues its PrintJobs into the Farm Pool.
   */
  async approveAndEnqueue(orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.printOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);
      if (order.status !== 'quoted' && order.status !== 'paid') {
        throw new ConflictException(`Order ${order.orderCode} cannot be approved from "${order.status}"`);
      }

      const updated = await tx.printOrder.update({
        where: { id: orderId },
        data: { status: 'queued' },
      });

      // Batch insert jobs for the requested quantity (single SQL INSERT, zero N+1)
      const jobCount = Math.min(order.quantity, 50);
      await tx.printJob.createMany({
        data: Array.from({ length: jobCount }, () => ({
          printerId: null,
          filename: order.filename,
          status: 'queued',
          priority: order.priority === 'express' ? 10 : 0,
          estimatedSec: order.estimatedSec,
          filamentGrams: order.estimatedGrams,
        })),
      });

      return { order: updated, jobsCreated: jobCount };
    });
  }

  async cancelOrder(orderId: string) {
    const existing = await this.prisma.printOrder.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Order ${orderId} not found`);

    return this.prisma.printOrder.update({
      where: { id: orderId },
      data: { status: 'cancelled' },
    });
  }

  /**
   * Computes an automatic 2D bin-packed batch plan across all `quoted` & `paid` orders
   * in 1 single JOIN query (zero N+1). Operators can review, exclude items manually, or approve.
   */
  async getBatchPlan(plateWidthMm = 256, plateDepthMm = 256) {
    const safeW = Math.max(120, Math.min(500, Number(plateWidthMm) || 256));
    const safeD = Math.max(120, Math.min(500, Number(plateDepthMm) || 256));

    const eligible = await this.prisma.printOrder.findMany({
      where: { status: { in: ['quoted', 'paid'] } },
      include: {
        material: { select: { code: true, name: true } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    });

    const plates = this.plateBatcher.planBatches(
      eligible.map((o) => ({
        orderId: o.id,
        orderCode: o.orderCode,
        filename: o.filename,
        materialCode: o.material.code,
        materialName: o.material.name,
        quantity: o.quantity,
        priority: o.priority,
        estimatedGrams: o.estimatedGrams,
      })),
      { plateWidthMm: safeW, plateDepthMm: safeD },
    );

    return { plateWidthMm: safeW, plateDepthMm: safeD, orderCount: eligible.length, plates };
  }

  /**
   * Atomically approves a selected set of orders (supporting manual operator override)
   * and enqueues them into the Farm Queue in 1 transaction + 1 batch INSERT.
   */
  async approveBatch(raw: unknown) {
    const schema = z.object({
      orderIds: z.array(z.string().min(1)).min(1).max(50),
      printerId: z.string().min(1).optional().nullable(),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const { orderIds, printerId } = parsed.data;
    const uniqueIds = [...new Set(orderIds)];

    return this.prisma.$transaction(async (tx) => {
      if (printerId) {
        const printer = await tx.printer.findUnique({
          where: { id: printerId },
          select: { id: true, mode: true },
        });
        if (!printer) {
          throw new NotFoundException(`Target printer ${printerId} not found`);
        }
        if (printer.mode === 'maintenance') {
          throw new ConflictException(`Target printer ${printerId} is currently in maintenance mode`);
        }
      }

      const found = await tx.printOrder.findMany({
        where: { id: { in: uniqueIds }, status: { in: ['quoted', 'paid'] } },
      });
      if (found.length === 0) {
        throw new ConflictException('No eligible quoted/paid orders found for batch approval');
      }

      await tx.printOrder.updateMany({
        where: { id: { in: found.map((o) => o.id) } },
        data: { status: 'queued' },
      });

      const jobsToCreate = found.flatMap((order) =>
        Array.from({ length: Math.min(order.quantity, 20) }, () => ({
          printerId: printerId ?? null,
          filename: order.filename,
          status: 'queued' as const,
          priority: order.priority === 'express' ? 10 : 0,
          estimatedSec: order.estimatedSec,
          filamentGrams: order.estimatedGrams,
        })),
      );

      await tx.printJob.createMany({ data: jobsToCreate });
      return { ordersApproved: found.length, jobsCreated: jobsToCreate.length };
    });
  }
}
