import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().min(6000).max(65535).default(6001),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  CORS_ORIGIN: z.string().default('http://127.0.0.1:6100,http://localhost:6100'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (PostgreSQL connection string)'),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIALS_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SEC: z.coerce.number().int().min(300).max(604800).default(86400),
  ADMIN_EMAIL: z.string().email().default('admin@printfarm.local'),
  ADMIN_PASSWORD: z.string().min(8).default('ChangeMeAdmin123!'),
  MEDIAMTX_API_URL: z.string().url().optional().or(z.literal('')),
  MEDIAMTX_WEBRTC_URL: z.string().url().optional().or(z.literal('')),
  UPLOAD_DIR: z.string().default('./storage/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1024).default(150),
  WS_BROADCAST_INTERVAL_MS: z.coerce.number().int().min(100).max(5000).default(500),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid backend environment configuration:\n${details}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}
