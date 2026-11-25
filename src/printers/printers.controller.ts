import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { AuthTokenPayload } from '../auth/token.util';
import { RateLimit } from '../common/rate-limit.guard';
import { PrintersService } from './printers.service';

@Controller('api/printers')
export class PrintersController {
  constructor(private readonly printers: PrintersService) {}

  @Roles('admin', 'operator')
  @Get('catalog')
  getCatalog() {
    return this.printers.getCatalog();
  }

  @Roles('admin')
  @RateLimit(6, 60_000)
  @Post('discover')
  discover(@Body() body: unknown) {
    return this.printers.discoverLanPrinters(body);
  }

  @Get()
  findAll(@CurrentUser() user: AuthTokenPayload) {
    return this.printers.findAll(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthTokenPayload) {
    return this.printers.findOne(id, user);
  }

  @Roles('admin', 'operator')
  @Post()
  create(@Body() body: unknown) {
    return this.printers.create(body);
  }

  @Roles('admin', 'operator')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.printers.update(id, body);
  }

  @Roles('admin', 'operator')
  @Post(':id/bed-clear')
  confirmBedClear(@Param('id') id: string) {
    return this.printers.confirmBedClear(id);
  }

  @Post(':id/commands')
  sendCommand(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthTokenPayload,
  ) {
    return this.printers.sendCommand(id, body, user);
  }

  @Post(':id/validate-gcode')
  validateGcode(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthTokenPayload,
  ) {
    return this.printers.validateGcode(id, body, user);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.printers.remove(id);
  }
}
