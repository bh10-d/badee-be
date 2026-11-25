import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { PrinterRegistryService } from '../adapters/core/printer-registry.service';

const SAFE_FILENAME_RE = /^[A-Za-z0-9._\-\s()]+\.(gcode|gco|3mf)$/i;

export const enqueueJobSchema = z.object({
  printerId: z.string().min(1).optional().nullable(),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (f) => !f.includes('..') && !f.includes('/') && !f.includes('\\') && SAFE_FILENAME_RE.test(f),
      'Filename must be a valid .gcode/.gco/.3mf file without path segments',
    ),
  priority: z.number().int().min(-10).max(100).optional().default(0),
  estimatedSec: z.number().int().positive().optional(),
  filamentGrams: z.number().positive().optional(),
});

export const dispatchJobSchema = z.object({
  printerId: z.string().min(1),
});

@Injectable()
export class QueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PrinterRegistryService,
  ) {}

  async list(printerId?: string) {
    // Single JOIN query — zero N+1.
    return this.prisma.printJob.findMany({
      where: printerId ? { printerId } : undefined,
      include: {
        printer: {
          select: {
            id: true,
            name: true,
            brand: true,
            model: true,
            bedStatus: true,
          },
        },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    });
  }

  async enqueue(raw: unknown) {
    const parsed = enqueueJobSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const dto = parsed.data;

    if (dto.printerId) {
      const printer = await this.prisma.printer.findUnique({
        where: { id: dto.printerId },
        select: { id: true },
      });
      if (!printer) throw new NotFoundException(`Printer ${dto.printerId} not found`);
    }

    return this.prisma.printJob.create({
      data: {
        printerId: dto.printerId ?? null,
        filename: dto.filename,
        priority: dto.priority,
        estimatedSec: dto.estimatedSec ?? null,
        filamentGrams: dto.filamentGrams ?? null,
      },
    });
  }

  async dispatch(jobId: string, raw: unknown) {
    const parsed = dispatchJobSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const { printerId } = parsed.data;

    const driver = this.registry.getDriver(printerId);
    if (!driver) {
      throw new ConflictException(`Printer ${printerId} has no active connection`);
    }

    const job = await this.prisma.$transaction(async (tx) => {
      const [foundJob, printer] = await Promise.all([
        tx.printJob.findUnique({ where: { id: jobId } }),
        tx.printer.findUnique({
          where: { id: printerId },
          select: { id: true, name: true, bedStatus: true, isEnabled: true },
        }),
      ]);

      if (!foundJob) throw new NotFoundException(`Job ${jobId} not found`);
      if (!printer) throw new NotFoundException(`Printer ${printerId} not found`);
      if (!printer.isEnabled) throw new ConflictException(`Printer ${printer.name} is disabled`);
      if (foundJob.status !== 'queued') {
        throw new ConflictException(`Job ${jobId} is not queued (status: ${foundJob.status})`);
      }
      if (printer.bedStatus !== 'clean') {
        throw new ConflictException(
          `Cannot start print: ${printer.name} bed status is "${printer.bedStatus}". Confirm bed is clear first.`,
        );
      }

      const updatedJob = await tx.printJob.update({
        where: { id: jobId },
        data: {
          printerId,
          status: 'dispatched',
          startedAt: new Date(),
        },
      });

      await tx.printer.update({
        where: { id: printerId },
        data: { bedStatus: 'dirty' },
      });

      return updatedJob;
    });

    try {
      await driver.startPrint(job.filename);
    } catch (err) {
      await this.prisma.printJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorMessage: (err as Error).message.slice(0, 512),
          finishedAt: new Date(),
        },
      });
      throw new ConflictException(`Failed to dispatch to printer: ${(err as Error).message}`);
    }

    return job;
  }

  async cancel(jobId: string) {
    const existing = await this.prisma.printJob.findUnique({
      where: { id: jobId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException(`Job ${jobId} not found`);

    return this.prisma.printJob.update({
      where: { id: jobId },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
  }
}
