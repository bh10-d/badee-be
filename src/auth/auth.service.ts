import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { getEnv } from '../config/env';
import { hashPassword, verifyPassword } from './password.util';
import { signToken } from './token.util';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
});

const createUserSchema = z.object({
  email: z.string().trim().email().max(160),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(8).max(128),
  role: z.enum(['admin', 'operator', 'renter']).default('renter'),
});

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const count = await this.prisma.user.count();
    if (count === 0) {
      const env = getEnv();
      await this.prisma.user.create({
        data: {
          email: env.ADMIN_EMAIL.toLowerCase(),
          name: 'Farm Administrator',
          passwordHash: hashPassword(env.ADMIN_PASSWORD),
          role: 'admin',
        },
      });
      this.logger.log(`Seeded initial admin user: ${env.ADMIN_EMAIL}`);
    }
  }

  async login(raw: unknown) {
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException('Invalid email or password format');
    }
    const email = parsed.data.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || !verifyPassword(parsed.data.password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const env = getEnv();
    const accessToken = signToken(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      env.JWT_SECRET,
      env.JWT_TTL_SEC,
    );

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async listUsers() {
    return this.prisma.user.findMany({
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createUser(raw: unknown) {
    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten().fieldErrors);
    }
    const dto = parsed.data;
    const email = dto.email.toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`User with email ${email} already exists`);
    }

    return this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        passwordHash: hashPassword(dto.password),
        role: dto.role as UserRole,
      },
      select: SAFE_USER_SELECT,
    });
  }
}
