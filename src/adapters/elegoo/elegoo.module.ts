import { Module } from '@nestjs/common';
import { ElegooAdapter } from './elegoo.adapter';

@Module({
  providers: [ElegooAdapter],
  exports: [ElegooAdapter],
})
export class ElegooModule {}
