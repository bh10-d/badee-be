import { Controller, Get, Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { Public } from './auth/auth.decorators';
import { AdaptersModule } from './adapters/adapters.module';
import { MediaModule } from './media/media.module';
import { RentalsModule } from './rentals/rentals.module';
import { PrintersModule } from './printers/printers.module';
import { QueueModule } from './queue/queue.module';
import { OrdersModule } from './orders/orders.module';
import { WsModule } from './ws/ws.module';
import { PrinterRegistryService } from './adapters/core/printer-registry.service';

@Controller('api/health')
class HealthController {
  constructor(private readonly registry: PrinterRegistryService) {}

  @Public()
  @Get()
  getHealth() {
    const states = Array.from(this.registry.getAllStates().values());
    return {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      printersTotal: states.length,
      printersConnected: states.filter((s) => s.connectionState === 'connected').length,
    };
  }
}

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AdaptersModule,
    MediaModule,
    RentalsModule,
    PrintersModule,
    QueueModule,
    OrdersModule,
    WsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
