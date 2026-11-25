import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PlateBatcherService } from './plate-batcher.service';
import { SlicerQuoteService } from './slicer-quote.service';

@Module({
  controllers: [OrdersController],
  providers: [SlicerQuoteService, PlateBatcherService, OrdersService],
  exports: [OrdersService, PlateBatcherService],
})
export class OrdersModule {}
