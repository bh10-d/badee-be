import 'dotenv/config';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

function encryptCredentials(payload, hexKey) {
  if (!hexKey || !/^[0-9a-fA-F]{64}$/.test(hexKey)) return null;
  const key = Buffer.from(hexKey, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function main() {
  const encKey = process.env.CREDENTIALS_ENCRYPTION_KEY;

  // 1. Users (Admin, Operator, Renter)
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@printfarm.local').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMeAdmin123!';

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: 'Farm Administrator',
      passwordHash: hashPassword(adminPassword),
      role: 'admin',
    },
  });

  const operator = await prisma.user.upsert({
    where: { email: 'operator@printfarm.local' },
    update: {},
    create: {
      email: 'operator@printfarm.local',
      name: 'Workshop Operator',
      passwordHash: hashPassword('Operator123!'),
      role: 'operator',
    },
  });

  const renter = await prisma.user.upsert({
    where: { email: 'renter@printfarm.local' },
    update: {},
    create: {
      email: 'renter@printfarm.local',
      name: 'Demo Renter',
      passwordHash: hashPassword('Renter123!'),
      role: 'renter',
    },
  });

  // 2. Filament Materials
  const materialsData = [
    { code: 'PLA', name: 'PLA+ Standard', pricePerGramVnd: 1200, densityGcm3: 1.24, colorHex: '#2f81f7', stockGrams: 5000 },
    { code: 'PETG', name: 'PETG Mechanical', pricePerGramVnd: 1500, densityGcm3: 1.27, colorHex: '#2ea043', stockGrams: 3000 },
    { code: 'ABS', name: 'ABS+ Engineering', pricePerGramVnd: 1700, densityGcm3: 1.04, colorHex: '#d29922', stockGrams: 2000 },
    { code: 'TPU', name: 'TPU 95A Flexible', pricePerGramVnd: 2200, densityGcm3: 1.21, colorHex: '#f85149', stockGrams: 1500 },
  ];

  for (const m of materialsData) {
    await prisma.filamentMaterial.upsert({
      where: { code: m.code },
      update: {},
      create: m,
    });
  }

  const pla = await prisma.filamentMaterial.findUniqueOrThrow({ where: { code: 'PLA' } });
  const petg = await prisma.filamentMaterial.findUniqueOrThrow({ where: { code: 'PETG' } });

  // 3. Demo Printers (disabled by default so seed never dials fake LAN IPs)
  const cc2 = await prisma.printer.upsert({
    where: { ip: '192.0.2.101' },
    update: {},
    create: {
      name: 'Elegoo CC2 — Bay 01',
      brand: 'elegoo',
      model: 'cc2',
      ip: '192.0.2.101',
      credentialsEncrypted: encryptCredentials({ password: '123456' }, encKey),
      mode: 'pool',
      bedStatus: 'clean',
      isEnabled: false,
    },
  });

  const kobraX = await prisma.printer.upsert({
    where: { ip: '192.0.2.102' },
    update: {},
    create: {
      name: 'Anycubic Kobra X — Bay 02',
      brand: 'anycubic',
      model: 'kobra-x',
      ip: '192.0.2.102',
      credentialsEncrypted: encryptCredentials({ lanToken: 'demo-lan-token' }, encKey),
      mode: 'rental',
      bedStatus: 'dirty',
      isEnabled: false,
    },
  });

  // 4. Sample Print Queue Jobs
  const existingJobs = await prisma.printJob.count();
  if (existingJobs === 0) {
    await prisma.printJob.createMany({
      data: [
        {
          printerId: cc2.id,
          filename: 'motor_mount_v3.gcode',
          status: 'queued',
          priority: 10,
          estimatedSec: 5400,
          filamentGrams: 48.5,
        },
        {
          printerId: null,
          filename: 'enclosure_hinge_x4.3mf',
          status: 'queued',
          priority: 0,
          estimatedSec: 7200,
          filamentGrams: 72.0,
        },
      ],
    });
  }

  // 5. Sample On-Demand Orders
  await prisma.printOrder.upsert({
    where: { orderCode: 'PF-DEMO-0001' },
    update: {},
    create: {
      orderCode: 'PF-DEMO-0001',
      customerName: 'Nguyen Van A',
      customerEmail: 'khach1@example.com',
      customerPhone: '0901234567',
      filename: 'gearbox_housing.stl',
      materialId: petg.id,
      quantity: 5,
      priority: 'express',
      estimatedGrams: 85,
      estimatedSec: 25500,
      unitPriceVnd: 166000,
      totalPriceVnd: 830000,
      status: 'quoted',
      notes: 'Infill 40%, màu đen nhám',
    },
  });

  await prisma.printOrder.upsert({
    where: { orderCode: 'PF-DEMO-0002' },
    update: {},
    create: {
      orderCode: 'PF-DEMO-0002',
      customerName: 'Tran Thi B',
      customerEmail: 'khach2@example.com',
      filename: 'keycap_set.3mf',
      materialId: pla.id,
      quantity: 2,
      priority: 'normal',
      estimatedGrams: 30,
      estimatedSec: 9000,
      unitPriceVnd: 51000,
      totalPriceVnd: 102000,
      status: 'paid',
    },
  });

  // 6. Sample Active Rental Session (24h window for Demo Renter on Kobra X)
  const existingRentals = await prisma.rentalSession.count();
  if (existingRentals === 0) {
    const now = new Date();
    const endsAt = new Date(now.getTime() + 24 * 3600 * 1000);
    await prisma.rentalSession.create({
      data: {
        printerId: kobraX.id,
        renterId: renter.id,
        status: 'active',
        startsAt: now,
        endsAt,
        maxNozzleTemp: 250,
        maxBedTemp: 90,
        allowPauseResume: true,
        allowStop: true,
        allowTempControl: false,
        allowHome: false,
        allowLight: true,
      },
    });
  }

  console.log('Seed completed:');
  console.log(`  Admin:    ${admin.email} / ${adminPassword}`);
  console.log(`  Operator: ${operator.email} / Operator123!`);
  console.log(`  Renter:   ${renter.email} / Renter123!`);
  console.log(`  Printers: ${cc2.name} (${cc2.ip}), ${kobraX.name} (${kobraX.ip})`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
