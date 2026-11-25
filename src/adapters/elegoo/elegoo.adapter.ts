import { Injectable } from '@nestjs/common';
import type {
  DriverInitConfig,
  IBrandAdapter,
  IPrinterDriver,
} from '../core/printer-driver.interface';
import { ElegooCc1Driver } from './drivers/cc1/cc1.driver';
import { ElegooCc2Driver } from './drivers/cc2/cc2.driver';

@Injectable()
export class ElegooAdapter implements IBrandAdapter {
  readonly brand = 'elegoo' as const;
  readonly supportedModels = ['cc1', 'cc2'] as const;

  createDriver(config: DriverInitConfig): IPrinterDriver {
    switch (config.model.toLowerCase()) {
      case 'cc1':
        return new ElegooCc1Driver(config);
      case 'cc2':
        return new ElegooCc2Driver(config);
      default:
        throw new Error(
          `Unsupported Elegoo model "${config.model}". Supported: ${this.supportedModels.join(', ')}`,
        );
    }
  }
}
