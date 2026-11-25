import { Body, Controller, Get, Post } from '@nestjs/common';
import { RateLimit } from '../common/rate-limit.guard';
import { AuthService } from './auth.service';
import { CurrentUser, Public, Roles } from './auth.decorators';
import type { AuthTokenPayload } from './token.util';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit(10, 60_000)
  @Post('login')
  login(@Body() body: unknown) {
    return this.auth.login(body);
  }

  @Get('me')
  me(@CurrentUser() user: AuthTokenPayload) {
    return {
      id: user.sub,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }

  @Roles('admin')
  @Get('users')
  listUsers() {
    return this.auth.listUsers();
  }

  @Roles('admin')
  @Post('users')
  createUser(@Body() body: unknown) {
    return this.auth.createUser(body);
  }
}
