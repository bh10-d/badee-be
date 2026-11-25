import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getEnv } from '../config/env';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { type AuthTokenPayload, verifyToken } from './token.util';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: AuthTokenPayload;
    }>();
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const payload = verifyToken(token, getEnv().JWT_SECRET);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    req.user = payload;

    const requiredRoles = this.reflector.getAllAndOverride<
      Array<'admin' | 'operator' | 'renter'> | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(payload.role)) {
      throw new ForbiddenException(`Requires role: ${requiredRoles.join(' or ')}`);
    }

    return true;
  }
}
