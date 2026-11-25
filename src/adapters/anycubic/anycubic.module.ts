import { Module } from '@nestjs/common';
import { AnycubicAdapter } from './anycubic.adapter';

@Module({
  providers: [AnycubicAdapter],
  exports: [AnycubicAdapter],
})
export class AnycubicModule {}
