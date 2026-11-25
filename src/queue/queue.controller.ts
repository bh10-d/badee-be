import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { QueueService } from './queue.service';

@Roles('admin', 'operator')
@Controller('api/queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  list(@Query('printerId') printerId?: string) {
    return this.queue.list(printerId);
  }

  @Post()
  enqueue(@Body() body: unknown) {
    return this.queue.enqueue(body);
  }

  @Post(':id/dispatch')
  dispatch(@Param('id') id: string, @Body() body: unknown) {
    return this.queue.dispatch(id, body);
  }

  @Delete(':id')
  cancel(@Param('id') id: string) {
    return this.queue.cancel(id);
  }
}
