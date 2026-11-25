import { Module } from '@nestjs/common';
import { FarmWsGateway } from './farm-ws.gateway';

@Module({
  providers: [FarmWsGateway],
})
export class WsModule {}
