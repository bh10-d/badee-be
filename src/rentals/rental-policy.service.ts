import { ForbiddenException, Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { PrismaService } from '../database/prisma.service';
import type { PrinterCommandDto } from '../printers/printers.service';

export interface RentalPolicySnapshot {
  status: string;
  startsAt: Date;
  endsAt: Date;
  maxNozzleTemp: number;
  maxBedTemp: number;
  allowPauseResume: boolean;
  allowStop: boolean;
  allowTempControl: boolean;
  allowHome: boolean;
  allowLight: boolean;
}

/**
 * Pure policy evaluation — unit-tested directly without DB.
 * Enforces hardware safety boundaries for remote printer renters.
 */
export function evaluateRentalCommandPolicy(
  session: RentalPolicySnapshot,
  cmd: PrinterCommandDto,
  now = new Date(),
): { allowed: true } | { allowed: false; reason: string } {
  if (session.status !== 'active') {
    return { allowed: false, reason: `Rental session is not active (status: ${session.status})` };
  }
  if (now < session.startsAt || now > session.endsAt) {
    return { allowed: false, reason: 'Rental session is outside its active time window' };
  }

  switch (cmd.action) {
    case 'emergency_stop':
      // Safety first: an active renter can always trigger E-Stop on their rented printer.
      return { allowed: true };
    case 'pause':
    case 'resume':
      return session.allowPauseResume
        ? { allowed: true }
        : { allowed: false, reason: 'Pause/Resume is disabled for this rental session' };
    case 'stop':
      return session.allowStop
        ? { allowed: true }
        : { allowed: false, reason: 'Stop print is disabled for this rental session' };
    case 'light':
      return session.allowLight
        ? { allowed: true }
        : { allowed: false, reason: 'Light control is disabled for this rental session' };
    case 'home':
      return session.allowHome
        ? { allowed: true }
        : { allowed: false, reason: 'Manual homing is restricted to farm operators' };
    case 'temperature':
      if (!session.allowTempControl) {
        return { allowed: false, reason: 'Manual temperature override is disabled for this rental' };
      }
      if (cmd.nozzle !== undefined && cmd.nozzle > session.maxNozzleTemp) {
        return {
          allowed: false,
          reason: `Nozzle target exceeds rental safety limit (${session.maxNozzleTemp}°C)`,
        };
      }
      if (cmd.bed !== undefined && cmd.bed > session.maxBedTemp) {
        return {
          allowed: false,
          reason: `Bed target exceeds rental safety limit (${session.maxBedTemp}°C)`,
        };
      }
      return { allowed: true };
    case 'move':
    case 'fan':
    case 'speed_mode':
    case 'maintenance':
    case 'filament':
      return {
        allowed: false,
        reason: `Command "${cmd.action}" is restricted to farm operators`,
      };
  }
}

@Injectable()
export class RentalPolicyService extends EventEmitter {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  notifySessionRevoked(renterId: string, printerId: string): void {
    this.emit('revoked', { renterId, printerId });
  }

  async getActiveSessionsForRenter(
    renterId: string,
  ): Promise<Array<{ printerId: string; startsAt: Date; endsAt: Date }>> {
    const now = new Date();
    return this.prisma.rentalSession.findMany({
      where: {
        renterId,
        status: 'active',
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      select: { printerId: true, startsAt: true, endsAt: true },
    });
  }

  async getActivePrinterIdsForRenter(renterId: string): Promise<string[]> {
    const sessions = await this.getActiveSessionsForRenter(renterId);
    return sessions.map((s) => s.printerId);
  }

  async getActiveSessionForRenterPrinter(renterId: string, printerId: string) {
    const now = new Date();
    return this.prisma.rentalSession.findFirst({
      where: {
        renterId,
        printerId,
        status: 'active',
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
    });
  }

  async assertRenterCanCommand(
    renterId: string,
    printerId: string,
    cmd: PrinterCommandDto,
  ): Promise<void> {
    const now = new Date();
    const session = await this.getActiveSessionForRenterPrinter(renterId, printerId);

    if (!session) {
      throw new ForbiddenException('You do not have an active rental session for this printer');
    }

    const decision = evaluateRentalCommandPolicy(session, cmd, now);
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
  }
}
