import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { AuthTokenPayload } from '../auth/token.util';
import { RentalsService } from './rentals.service';

@Controller('api/rentals')
export class RentalsController {
  constructor(private readonly rentals: RentalsService) {}

  @Get()
  list(@CurrentUser() user: AuthTokenPayload) {
    return this.rentals.list(user);
  }

  @Roles('admin', 'operator')
  @Post()
  create(@Body() body: unknown) {
    return this.rentals.create(body);
  }

  @Roles('admin', 'operator')
  @Post(':id/revoke')
  revoke(@Param('id') id: string) {
    return this.rentals.revoke(id);
  }
}
