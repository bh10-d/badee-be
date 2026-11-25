import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import type { AuthTokenPayload } from '../auth/token.util';
import { RentalPolicyService } from './rental-policy.service';

const createRentalSchema = z.object({
  printerId: z.string().min(1),
  renterId: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  maxNozzleTemp: z.number().int().min(0).max(300).default(260),
  maxBedTemp: z.number().int().min(0).max(110).default(100),
  allowPauseResume: z.boolean().default(true),
  allowStop: z.boolean().default(true),
  allowTempControl: z.boolean().default(false),
  allowHome: z.boolean().default(false),
  allowLight: z.boolean().default(true),
});

@Injectable()
export class RentalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rentalPolicy: RentalPolicyService,
  ) {}

  async list(user: AuthTokenPayload) {
    // Single JOIN query — zero N+1. Renters only ever see their own sessions.
    return this.prisma.rentalSession.findMany({
      where: user.role === 'renter' ? { renterId: user.sub } : undefined,
      include: {
        printer: { select: { id: true, name: true, brand: true, model: true, bedStatus: true } },
        renter: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async create(raw: unknown) {
    const parsed = createRentalSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const dto = parsed.data;
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    return this.prisma.$transaction(async (tx) => {
      const [printer, renter, overlap] = await Promise.all([
        tx.printer.findUnique({ where: { id: dto.printerId }, select: { id: true, name: true } }),
        tx.user.findUnique({ where: { id: dto.renterId }, select: { id: true, isActive: true } }),
        tx.rentalSession.findFirst({
          where: {
            printerId: dto.printerId,
            status: { in: ['scheduled', 'active'] },
            startsAt: { lt: endsAt },
            endsAt: { gt: startsAt },
          },
          select: { id: true },
        }),
      ]);

      if (!printer) throw new NotFoundException(`Printer ${dto.printerId} not found`);
      if (!renter || !renter.isActive) throw new NotFoundException(`Active renter ${dto.renterId} not found`);
      if (overlap) {
        throw new ConflictException(`Printer ${printer.name} already has an overlapping rental session`);
      }

      const session = await tx.rentalSession.create({
        data: {
          printerId: dto.printerId,
          renterId: dto.renterId,
          status: 'active',
          startsAt,
          endsAt,
          maxNozzleTemp: dto.maxNozzleTemp,
          maxBedTemp: dto.maxBedTemp,
          allowPauseResume: dto.allowPauseResume,
          allowStop: dto.allowStop,
          allowTempControl: dto.allowTempControl,
          allowHome: dto.allowHome,
          allowLight: dto.allowLight,
        },
        include: {
          printer: { select: { id: true, name: true, brand: true, model: true } },
          renter: { select: { id: true, name: true, email: true } },
        },
      });

      await tx.printer.update({
        where: { id: dto.printerId },
        data: { mode: 'rental' },
      });

      return session;
    });
  }

  async revoke(id: string) {
    const existing = await this.prisma.rentalSession.findUnique({
      where: { id },
      select: { id: true, printerId: true, renterId: true },
    });
    if (!existing) throw new NotFoundException(`Rental session ${id} not found`);

    const updated = await this.prisma.rentalSession.update({
      where: { id },
      data: { status: 'revoked' },
    });
    // Immediately sever live WebSocket telemetry for the revoked renter
    this.rentalPolicy.notifySessionRevoked(existing.renterId, existing.printerId);
    return updated;
  }
}
