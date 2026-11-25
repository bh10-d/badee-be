import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export const RateLimit = (limit: number, windowMs: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowMs } satisfies RateLimitOptions);

const MAX_TRACKED_KEYS = 10_000;

/**
 * Lightweight, memory-bounded sliding-window rate limiter per client IP + route.
 * Protects `/api/auth/login` (brute-force) and `/api/public/quotes` (DB-fill DoS).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!opts) return true;

    const req = context.switchToHttp().getRequest<{
      ip?: string;
      socket?: { remoteAddress?: string };
      route?: { path?: string };
      url?: string;
    }>();

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const route = req.route?.path || req.url || 'unknown';
    const key = `${ip}:${route}`;
    const now = Date.now();
    const cutoff = now - opts.windowMs;

    const existing = this.buckets.get(key) ?? [];
    const recent = existing.filter((ts) => ts > cutoff);

    if (recent.length >= opts.limit) {
      this.buckets.set(key, recent);
      throw new HttpException(
        'Too many requests. Please wait and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.buckets.set(key, recent);

    // Bounded memory guard: evict oldest entries if map grows past limit
    if (this.buckets.size > MAX_TRACKED_KEYS) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey) this.buckets.delete(oldestKey);
    }

    return true;
  }
}
