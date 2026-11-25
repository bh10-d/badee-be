import { Injectable } from '@nestjs/common';
import type {
  DriverInitConfig,
  IBrandAdapter,
  IPrinterDriver,
} from '../core/printer-driver.interface';
import { AnycubicKobraXDriver } from './drivers/kobra-x/kobra-x.driver';

@Injectable()
export class AnycubicAdapter implements IBrandAdapter {
  readonly brand = 'anycubic' as const;
  readonly supportedModels = ['kobra-x'] as const;

  createDriver(config: DriverInitConfig): IPrinterDriver {
    switch (config.model.toLowerCase()) {
      case 'kobra-x':
        return new AnycubicKobraXDriver(config);
      default:
        throw new Error(
          `Unsupported Anycubic model "${config.model}". Supported: ${this.supportedModels.join(', ')}`,
        );
    }
  }
}
