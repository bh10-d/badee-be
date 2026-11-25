import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators';
import { type AuthTokenPayload, verifyToken } from '../auth/token.util';
import { getEnv } from '../config/env';
import { RateLimit } from '../common/rate-limit.guard';
import { PrintersService } from './printers.service';

@Controller('api/printers')
export class PrintersController {
  constructor(private readonly printers: PrintersService) {}

  @Roles('admin', 'operator')
  @Get('catalog')
  getCatalog() {
    return this.printers.getCatalog();
  }

  @Roles('admin')
  @RateLimit(6, 60_000)
  @Post('discover')
  discover(@Body() body: unknown) {
    return this.printers.discoverLanPrinters(body);
  }

  @Get()
  findAll(@CurrentUser() user: AuthTokenPayload) {
    return this.printers.findAll(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthTokenPayload) {
    return this.printers.findOne(id, user);
  }

  @Roles('admin', 'operator')
  @Post()
  create(@Body() body: unknown) {
    return this.printers.create(body);
  }

  @Roles('admin', 'operator')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.printers.update(id, body);
  }

  @Roles('admin', 'operator')
  @Post(':id/bed-clear')
  confirmBedClear(@Param('id') id: string) {
    return this.printers.confirmBedClear(id);
  }

  @Post(':id/commands')
  sendCommand(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthTokenPayload,
  ) {
    return this.printers.sendCommand(id, body, user);
  }

  @Post(':id/validate-gcode')
  validateGcode(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthTokenPayload,
  ) {
    return this.printers.validateGcode(id, body, user);
  }

  @Public()
  @Get(':id/camera-stream')
  async streamCamera(
    @Param('id') id: string,
    @Query('token') queryToken: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const rawToken = bearer || (queryToken ?? '').trim();
    const user = rawToken ? verifyToken(rawToken, getEnv().JWT_SECRET) : null;
    if (!user) {
      throw new UnauthorizedException('Invalid or missing camera stream token');
    }

    const { streamUrl } = await this.printers.resolveCameraStream(id, user);
    const client = streamUrl.startsWith('https://') ? https : http;

    const upstream = client.get(
      streamUrl,
      { timeout: 15_000, rejectUnauthorized: false },
      (upstreamRes) => {
        upstreamRes.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        if (!upstreamRes.statusCode || upstreamRes.statusCode >= 400) {
          if (!res.headersSent) {
            res.status(upstreamRes.statusCode ?? 502).end('Camera stream unavailable');
          }
          upstreamRes.resume();
          return;
        }
        const contentType = upstreamRes.headers['content-type'] ?? 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-Accel-Buffering', 'no');
        upstreamRes.pipe(res);
      },
    );

    upstream.on('timeout', () => {
      upstream.destroy();
      if (!res.headersSent) {
        res.status(504).end('Upstream camera timeout');
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end('Upstream camera unreachable');
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    res.on('error', () => {
      upstream.destroy();
    });

    req.on('close', () => {
      upstream.destroy();
    });
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.printers.remove(id);
  }
}
