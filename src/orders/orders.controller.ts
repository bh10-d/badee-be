import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { RateLimit } from '../common/rate-limit.guard';
import { Public, Roles } from '../auth/auth.decorators';
import { OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Public()
  @Get('api/public/farm-summary')
  getPublicFarmSummary() {
    return this.orders.getPublicFarmSummary();
  }

  @Public()
  @Get('api/public/materials')
  listPublicMaterials() {
    return this.orders.listPublicMaterials();
  }

  @Public()
  @RateLimit(15, 300_000)
  @Post('api/public/quotes')
  createQuoteOrder(@Body() body: unknown) {
    return this.orders.createQuoteOrder(body);
  }

  @Roles('admin', 'operator')
  @Get('api/orders')
  listOrders() {
    return this.orders.listOrders();
  }

  @Roles('admin', 'operator')
  @Get('api/orders/batch-plan')
  getBatchPlan(@Query('plateX') plateX?: string, @Query('plateY') plateY?: string) {
    return this.orders.getBatchPlan(
      plateX ? Number(plateX) : undefined,
      plateY ? Number(plateY) : undefined,
    );
  }

  @Roles('admin', 'operator')
  @Post('api/orders/batch-approve')
  approveBatch(@Body() body: unknown) {
    return this.orders.approveBatch(body);
  }

  @Roles('admin', 'operator')
  @Post('api/orders/:id/approve')
  approveOrder(@Param('id') id: string) {
    return this.orders.approveAndEnqueue(id);
  }

  @Roles('admin', 'operator')
  @Delete('api/orders/:id')
  cancelOrder(@Param('id') id: string) {
    return this.orders.cancelOrder(id);
  }
}
