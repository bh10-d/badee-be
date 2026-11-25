# ARCHITECTURE.md — PrintFarm Backend

## 1. Cấu trúc module (`src/`)
- `config/env.ts`: Validate toàn bộ biến môi trường qua Zod (`API_PORT >= 6000`, `DATABASE_URL`, `CREDENTIALS_ENCRYPTION_KEY`).
- `common/crypto.util.ts`: Mã hóa/giải mã credentials máy in bằng AES-256-GCM.
- `common/network.util.ts`: Validate IPv4 và chặn SSRF (`127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`, `>= 224`, ép `cameraUrl` trùng IP máy in).
- `database/`: `PrismaService` + `DatabaseModule` kết nối PostgreSQL.
- `auth/`: `AuthModule` (global `AuthGuard`, `@Public()`, `@Roles()`, `scrypt` password hashing, HMAC-SHA256 JWT, auto-seed Admin).
- `rentals/`: `RentalsModule` + `RentalPolicyService` (quản lý phiên thuê theo khung giờ + Policy Filter khóa lệnh nguy hiểm & giới hạn nhiệt độ cho khách thuê).
- `adapters/`: Gom theo **tên hãng**:
  - `adapters/core/`: `IPrinterDriver`, `IBrandAdapter`, `UnifiedPrinterState`, `PrinterRegistryService`.
  - `adapters/elegoo/`: `ElegooAdapter` → `drivers/cc2/` (`cc2.driver.ts`, `cc2.protocol.ts`).
  - `adapters/anycubic/`: `AnycubicAdapter` → `drivers/kobra-x/` (`kobra-x.driver.ts`).
- `printers/`: CRUD máy in, `/api/printers/catalog`, `/bed-clear`, `/commands`.
- `queue/`: Hàng đợi in + atomic `$transaction` kiểm tra `bedStatus === 'clean'`.
- `media/`: `MediaMtxService` đăng ký path stream camera (CC2 MJPEG / Kobra X HTTP-FLV) vào MediaMTX `:6997`.
- `orders/`: `SlicerQuoteService` + `OrdersService` (`/api/public/farm-summary`, `/api/public/materials`, `/api/public/quotes`, `/api/orders`, `/api/orders/:id/approve`).
- `ws/`: `FarmWsGateway` (`/ws`) gom batch telemetry theo chu kỳ `WS_BROADCAST_INTERVAL_MS` (`500ms`).

## 2. Bản đồ Port (`.env`)
- `API_PORT=6001`, `POSTGRES_PORT=6432`, `MEDIAMTX_HLS_PORT=6888`, `MEDIAMTX_WEBRTC_PORT=6889`, `MEDIAMTX_API_PORT=6997`.

## 3. Schema PostgreSQL (`prisma/schema.prisma`)
- `Printer` (unique `ip`, index `(brand, model)`, `(mode, bedStatus)`, `isEnabled`).
- `PrintJob` (index `(printerId, status, priority DESC, createdAt ASC)`, `(status, createdAt ASC)`).
- `PrinterEvent` (index `(printerId, createdAt DESC)`, `(level, createdAt DESC)`).
