import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { Server, WebSocket } from 'ws';
import { PrinterRegistryService } from '../adapters/core/printer-registry.service';
import type { UnifiedPrinterState } from '../adapters/core/printer-driver.interface';
import { type AuthTokenPayload, verifyToken } from '../auth/token.util';
import { RentalPolicyService } from '../rentals/rental-policy.service';
import { getEnv } from '../config/env';

interface AuthenticatedClient {
  socket: WebSocket;
  user: AuthTokenPayload;
  /** null means full farm access (admin/operator); Map<printerId, endsAtMs> for renters */
  allowedPrinters: Map<string, number> | null;
}

/**
 * Multi-tenant, JWT-authenticated, throttled WebSocket gateway at `/ws`.
 * Enforces JWT expiry, rental window expiry, and instant revocation on live sockets.
 */
@WebSocketGateway({ path: '/ws' })
export class FarmWsGateway
  implements OnModuleInit, OnModuleDestroy, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(FarmWsGateway.name);
  private readonly clients = new Map<WebSocket, AuthenticatedClient>();
  private readonly dirtyStates = new Map<string, UnifiedPrinterState>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly registry: PrinterRegistryService,
    private readonly rentalPolicy: RentalPolicyService,
  ) {}

  onModuleInit(): void {
    this.registry.on('state', (state: UnifiedPrinterState) => {
      this.dirtyStates.set(state.printerId, state);
    });

    this.rentalPolicy.on('revoked', ({ renterId, printerId }: { renterId: string; printerId: string }) => {
      for (const entry of this.clients.values()) {
        if (entry.user.sub === renterId && entry.allowedPrinters) {
          entry.allowedPrinters.delete(printerId);
          if (entry.allowedPrinters.size === 0) {
            entry.socket.close(4003, 'Rental session revoked');
            this.clients.delete(entry.socket);
          }
        }
      }
    });

    const intervalMs = getEnv().WS_BROADCAST_INTERVAL_MS;
    this.flushTimer = setInterval(() => this.flush(), intervalMs);
  }

  onModuleDestroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.clients.clear();
  }

  async handleConnection(client: WebSocket, req?: IncomingMessage): Promise<void> {
    const rawUrl = req?.url ?? '';
    const token = new URL(rawUrl, 'http://localhost').searchParams.get('token') ?? '';
    const user = verifyToken(token, getEnv().JWT_SECRET);
    if (!user) {
      client.close(4001, 'Unauthorized');
      return;
    }

    let allowedPrinters: Map<string, number> | null = null;
    if (user.role === 'renter') {
      const sessions = await this.rentalPolicy.getActiveSessionsForRenter(user.sub);
      allowedPrinters = new Map(sessions.map((s) => [s.printerId, s.endsAt.getTime()]));
    }

    const entry: AuthenticatedClient = { socket: client, user, allowedPrinters };
    this.clients.set(client, entry);

    const allStates = Array.from(this.registry.getAllStates().values());
    const visible = allowedPrinters
      ? allStates.filter((s) => allowedPrinters!.has(s.printerId))
      : allStates;
    this.safeSend(client, JSON.stringify({ type: 'snapshot', printers: visible }));
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
  }

  private flush(): void {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // Enforce JWT expiry and rental session expiry even on idle ticks
    for (const [socket, entry] of this.clients.entries()) {
      if (entry.user.exp <= nowSec) {
        socket.close(4002, 'Token expired');
        this.clients.delete(socket);
        continue;
      }
      if (entry.allowedPrinters) {
        for (const [pid, endsAt] of entry.allowedPrinters.entries()) {
          if (endsAt <= nowMs) entry.allowedPrinters.delete(pid);
        }
      }
    }

    if (this.dirtyStates.size === 0 || this.clients.size === 0) {
      this.dirtyStates.clear();
      return;
    }

    const batch = Array.from(this.dirtyStates.values());
    this.dirtyStates.clear();

    let adminPayload: string | null = null;

    for (const entry of this.clients.values()) {
      if (entry.allowedPrinters === null) {
        if (!adminPayload) {
          adminPayload = JSON.stringify({ type: 'telemetry_batch', printers: batch });
        }
        this.safeSend(entry.socket, adminPayload);
      } else {
        const filtered = batch.filter((s) => entry.allowedPrinters!.has(s.printerId));
        if (filtered.length > 0) {
          this.safeSend(
            entry.socket,
            JSON.stringify({ type: 'telemetry_batch', printers: filtered }),
          );
        }
      }
    }
  }

  private safeSend(client: WebSocket, payload: string): void {
    if (client.readyState !== 1) return;
    try {
      client.send(payload);
    } catch (err) {
      this.logger.warn(`WS send failed: ${(err as Error).message}`);
    }
  }
}
