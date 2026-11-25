import { Global, Module } from '@nestjs/common';
import { ElegooModule } from './elegoo/elegoo.module';
import { AnycubicModule } from './anycubic/anycubic.module';
import { PrinterRegistryService } from './core/printer-registry.service';
import { LanDiscoveryService } from './discovery/lan-discovery.service';

@Global()
@Module({
  imports: [ElegooModule, AnycubicModule],
  providers: [PrinterRegistryService, LanDiscoveryService],
  exports: [PrinterRegistryService, LanDiscoveryService],
})
export class AdaptersModule {}
