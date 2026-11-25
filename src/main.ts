import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { json } from 'express';
import { AppModule } from './app.module';
import { getEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const logger = new Logger('Bootstrap');

  // Disable default 100kb global bodyParser so we can enforce route-scoped limits:
  // 12MB only for G-code safety validation; strict 512KB for all other JSON APIs.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use('/api/printers/:id/validate-gcode', json({ limit: '12mb' }));
  app.use(json({ limit: '512kb' }));
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.disable?.('x-powered-by');
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, env.API_HOST);
  logger.log(`Print Farm API listening on http://${env.API_HOST}:${env.API_PORT}`);
  logger.log(`WebSocket telemetry gateway ready at ws://${env.API_HOST}:${env.API_PORT}/ws`);
}

bootstrap().catch((err: Error) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
