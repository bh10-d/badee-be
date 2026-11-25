import { Injectable } from '@nestjs/common';
import type {
  DriverInitConfig,
  IBrandAdapter,
  IPrinterDriver,
} from '../core/printer-driver.interface';
import { ElegooCc2Driver } from './drivers/cc2/cc2.driver';

@Injectable()
export class ElegooAdapter implements IBrandAdapter {
  readonly brand = 'elegoo' as const;
  readonly supportedModels = ['cc2'] as const;

  createDriver(config: DriverInitConfig): IPrinterDriver {
    switch (config.model.toLowerCase()) {
      case 'cc2':
        return new ElegooCc2Driver(config);
      default:
        throw new Error(
          `Unsupported Elegoo model "${config.model}". Supported: ${this.supportedModels.join(', ')}`,
        );
    }
  }
}
