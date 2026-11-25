import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthTokenPayload } from './token.util';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const Roles = (...roles: Array<'admin' | 'operator' | 'renter'>) =>
  SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthTokenPayload => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthTokenPayload }>();
    return req.user;
  },
);
