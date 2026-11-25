# WORKFLOW_HISTORY.md — Backend Repo

> Đọc file này và [ARCHITECTURE.md](./ARCHITECTURE.md) trước khi bắt đầu task mới trong repo `backend`.

## Trạng thái hiện tại
- **Giai đoạn:** **HOÀN TẤT CẢ 3 GIAI ĐOẠN** (GĐ 1 Farm Core + GĐ 2 On-Demand + GĐ 3 Auth/RBAC & Remote Rental Policy Filter).
- **Task kế tiếp:** Chạy `docker compose up -d` + `npm install` + `npx prisma generate && npx prisma db push` + `npm test` + `npm run dev` để chạy thực tế trên máy.

---

## Lịch sử Task

### [Operator Console Backend] Mở rộng lệnh vận hành (`move`, `fan`, `speed_mode`, `maintenance`)
- **Ngày:** 2026-11-25
- **Đã thực hiện:** Bổ sung `move`, `setFan`, `setSpeedMode`, `runMaintenance` vào `IPrinterDriver`, `ElegooCc2Driver` (method 1027/1030/1031/1032–1035), `AnycubicKobraXDriver`, `PrintersService` và khóa chặt các lệnh này trong `RentalPolicyService` (chỉ `admin`/`operator` được phép chạy).
- **Audit 3 chiều:**
  - **Hiệu suất:** Không phát sinh query DB mới ngoài 1 dòng audit `PrinterEvent`.
  - **Bảo mật:** `deltaMm` kẹp cứng `[-50, 50]`, `speedPercent` kẹp `[0, 100]`, `renter` bị từ chối `403 Forbidden` cho cả 4 lệnh trên ở tầng `RentalPolicyService`.

### [Seed Script] Thêm `prisma/seed.mjs` (idempotent, không cần cài thêm package)
- **Ngày:** 2026-11-25
- **Đã thực hiện:** Tạo [prisma/seed.mjs](../prisma/seed.mjs) và lệnh `npm run prisma:seed` tạo sẵn 3 tài khoản mẫu (`admin`, `operator`, `renter`), 4 vật liệu (`PLA`, `PETG`, `ABS`, `TPU`), 2 máy mẫu (`Elegoo CC2` + `Anycubic Kobra X` với IP TEST-NET `192.0.2.x` ở trạng thái `isEnabled: false` để không tự dial IP giả), 2 job hàng đợi, 2 đơn On-Demand và 1 phiên thuê 24h cho `renter`.

### [Audit Remediation] Kiểm tra phản biện độc lập (Bảo mật + Hiệu suất + DB) & Vá 6 lỗi thật
- **Ngày:** 2026-11-25
- **Các lỗi thật phát hiện & đã vá ngay:**
  1. **[HIGH - Bảo mật] WebSocket Stale Authorization (`farm-ws.gateway.ts`)**: Trước đây WS chỉ kiểm tra quyền thuê lúc mới mở kết nối → phiên thuê hết hạn hoặc bị `Revoke` vẫn nhận telemetry. **Đã vá:** lưu `Map<printerId, endsAtMs>` + kiểm tra `user.exp` trên mỗi chu kỳ `flush()` (đóng socket `4002` khi hết hạn) và lắng nghe sự kiện `revoked` từ `RentalPolicyService` để cắt socket `4003` tức thì.
  2. **[HIGH - Bảo mật] Thiếu Rate Limiting trên `POST /api/auth/login` & `POST /api/public/quotes`**: Dễ bị brute-force mật khẩu hoặc spam đầy DB. **Đã vá:** thêm `src/common/rate-limit.guard.ts` (sliding-window per-IP, giới hạn bộ nhớ `10,000` key) gắn `@RateLimit(10, 60_000)` cho login và `@RateLimit(15, 300_000)` cho quotes.
  3. **[HIGH - Bảo mật Multi-tenant] Rò rỉ `events` & `jobs` của khách trước trong `PrintersService.findOne()`**: Khách thuê mới xem được 25 event cũ và hàng đợi của xưởng/khách khác. **Đã vá:** lọc `events` chỉ từ `session.startsAt` trở đi và ẩn `jobs` đối với `renter`.
  4. **[HIGH - Hiệu suất / DB Bomb] `ElegooCc2Driver` ghi spam DB ~1 lần/giây khi máy đang có mã lỗi**: `api_status` lặp lại cùng `exception_status` sẽ gọi `prisma.printerEvent.create()` liên tục. **Đã vá:** thêm `activeExceptions` Set để chỉ emit khi xuất hiện mã lỗi **mới** (transition-only).
  5. **[MEDIUM - Bảo mật] Thiếu HTTP Security Headers (`main.ts`)**: **Đã vá:** tắt `x-powered-by`, gắn `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
  6. **[MEDIUM - DB] Lỗi `P2002`/`P2025` chưa bắt trong `update()` & `confirmBedClear()`**: **Đã vá:** kiểm tra trùng IP (`409 Conflict`) và kiểm tra tồn tại (`404 Not Found`).

### [Task P3-1] Auth/RBAC (JWT + scrypt), Remote Rental Sessions & Hardware Safety Policy Filter
- **Ngày:** 2026-11-25
- **Đã thực hiện:**
  - Mở rộng `prisma/schema.prisma`: thêm `User` (`admin | operator | renter`) và `RentalSession` (kèm composite index `(renterId, status, endsAt)` và `(printerId, status, endsAt)`).
  - Xây `AuthModule` (`password.util.ts` dùng `scryptSync` + `timingSafeEqual`, `token.util.ts` HMAC-SHA256 JWT, `AuthGuard` toàn cục với `@Public()` / `@Roles()`, auto-seed tài khoản Admin từ `ADMIN_EMAIL`/`ADMIN_PASSWORD`).
  - Xây `RentalsModule` (`rental-policy.service.ts`, `rentals.service.ts`, `rentals.controller.ts`): kiểm tra phiên thuê trùng lịch trong `$transaction`, áp dụng **Policy Filter** chặn `home`, khóa chỉnh nhiệt độ hoặc ép ngưỡng `maxNozzleTemp`/`maxBedTemp` cho khách thuê (luôn cho phép `emergency_stop` khi phiên đang active).
  - Nâng cấp `FarmWsGateway` xác thực JWT qua `?token=` và cách ly multi-tenant (khách thuê chỉ nhận telemetry đúng máy mình đang thuê).
  - Thêm unit tests `src/auth/auth-crypto.spec.ts` và `src/rentals/rental-policy.spec.ts`.
- **Audit 3 chiều:**
  - **Hiệu suất:** `FarmWsGateway.flush()` serialize 1 lần duy nhất cho toàn bộ Admin/Operator, chỉ filter riêng khi có Renter kết nối; `RentalsService.create()` kiểm tra `printer`, `renter`, `overlap` song song bằng `Promise.all` trong `$transaction`.
  - **Database & N+1:** `RentalsService.list()` 1 query JOIN duy nhất (`printer` + `renter`); `PrintersService.findAll()` cho Renter dùng `where: { id: { in: allowedIds } }` (1 query duy nhất).
  - **Bảo mật:** `SAFE_USER_SELECT` không bao giờ trả `passwordHash`; mật khẩu hash bằng `scrypt` + salt ngẫu nhiên 16 byte + so sánh constant-time `timingSafeEqual`; WS đóng ngay với mã `4001` nếu token không hợp lệ; mọi endpoint quản trị đều khóa sau `@Roles('admin', 'operator')`.

### [Task P2-1] Thêm On-Demand Orders/Materials, Quote Engine & MediaMTX Gateway
- **Ngày:** 2026-11-25
- **Đã thực hiện:**
  - Mở rộng `prisma/schema.prisma`: thêm `FilamentMaterial` và `PrintOrder` (kèm composite index `(isActive, code)`, `(status, createdAt DESC)`, `(customerEmail, createdAt DESC)`).
  - Tạo `MediaModule` (`src/media/mediamtx.service.ts`) tích hợp MediaMTX Control API `:6997`.
  - Tạo `OrdersModule` (`slicer-quote.service.ts`, `orders.service.ts`, `orders.controller.ts`, `slicer-quote.spec.ts`): public endpoints cho Next.js (`/api/public/farm-summary`, `/api/public/materials`, `/api/public/quotes`) và admin endpoints (`/api/orders`, `/api/orders/:id/approve`).
  - Cập nhật `CORS_ORIGIN` cho phép thêm `landing` (`:6002`).
- **Audit 3 chiều:**
  - **Hiệu suất:** `getPublicFarmSummary()` chạy 3 `count()` song song qua `Promise.all`; `MediaMtxService.registerPath()` có `AbortController` timeout `4s`.
  - **Database & N+1:** `listOrders()` 1 query JOIN duy nhất với `material`; `approveAndEnqueue()` dùng `$transaction` + `createMany` (1 lệnh `INSERT` batch cho toàn bộ số lượng sản phẩm, không insert trong vòng lặp).
  - **Bảo mật:** `/api/public/farm-summary` không lộ IP máy in, SN hay PII khách hàng; `createQuoteOrderSchema` validate email, giới hạn khối lượng `1–5000g`, số lượng `1–500`, chặn path traversal tên file; `approveAndEnqueue` chặn tạo quá 50 job/lần.

### [Task 1–5] Khởi tạo Backend NestJS + PostgreSQL + Brand Adapters (`elegoo`, `anycubic`) + API/WS/Queue + Tách repo độc lập
- **Ngày:** 2026-11-25
- **Đã thực hiện:**
  - Thiết lập NestJS + Prisma (`Printer`, `PrintJob`, `PrinterEvent`) + `docker-compose.yml` (PostgreSQL `:6432`, MediaMTX `:6888/:6889/:6997`).
  - Xây Brand Adapter gom theo tên hãng: `adapters/elegoo/drivers/cc2/` (migrate đầy đủ MQTT bridge, `cc2.protocol.ts`, `enableVideoStreamSDCP()`) và `adapters/anycubic/drivers/kobra-x/` (LAN Mode `:18910` + mTLS MQTT `:9883` + FLV `:18088`).
  - Xây `PrintersModule`, `QueueModule` (`$transaction` kiểm tra `bedStatus === 'clean'`), `FarmWsGateway` (batch `500ms`), unit test bảo mật `src/common/security.spec.ts`.
  - Tách hoàn toàn các file vận hành & docs về bên trong repo `backend/`.
- **Audit 3 chiều:**
  - **Hiệu suất:** Telemetry WS gộp batch `500ms`; mọi timer/socket đều cleanup trong `disconnect()` và `onModuleDestroy()`; HTTP probe timeout `5s` & SDCP WS timeout `10s`.
  - **Database & N+1:** `findAll()`, `findOne()`, `queue.list()`, `onModuleInit()` đều là single query có `select`/`include` + composite index; `dispatch()` dùng `$transaction` + `Promise.all`.
  - **Bảo mật:** Credentials mã hóa AES-256-GCM và không bao giờ trả về (`SAFE_PRINTER_SELECT`); SSRF guard cho IPv4 & `cameraUrl`; chặn path traversal tên file; giới hạn ngưỡng nhiệt độ an toàn; Docker bind `127.0.0.1`.

---

## 2026-11-25 — Remote Rental G-code Safety Validator & Semi-Auto 2D Plate Batcher

### Changes
- Added `src/rentals/gcode-validator.service.ts` (+ `gcode-validator.spec.ts`): fast linear G-code scanner (<50ms, zero server-side slicing) that blocks destructive commands (`M500`, `M502`, `M303`, `M997`, `M112`, `G29`), enforces rental nozzle/bed temperature caps, checks `G0/G1` build-volume bounds, parses slicer metadata (`estimated printing time`, `filament used [g]`), and blocks prints exceeding remaining rental time.
- Added `POST /api/printers/:id/validate-gcode` in `PrintersController` / `PrintersService` with renter session enforcement.
- Added `src/orders/plate-batcher.service.ts` (+ `plate-batcher.spec.ts`): 2D Shelf Bin-Packing planner (<2ms) grouping small same-material On-Demand orders with 10mm edge margin, 8mm part gap, max 8 parts/plate, and automatic isolation of large parts (`>=45%` usable area) onto dedicated plates.
- Added `GET /api/orders/batch-plan` and `POST /api/orders/batch-approve` (`@Roles('admin', 'operator')`) supporting manual operator override (exclude any order before batch approval).
- Configured route-scoped JSON body size limits in `src/main.ts` (`12mb` only on `/api/printers/:id/validate-gcode`, `512kb` globally).

### Verification & 3-Way Audit
- **Tests:** `npm run typecheck` + `npm test` → 6/6 test suites, 18/18 tests PASS.
- **Performance:** Linear `O(N)` G-code scan (<50ms) and `O(K log K)` 2D bin packing (<2ms); zero heavy server-side slicing.
- **DB/N+1:** Single JOIN `findMany` in `getBatchPlan`; atomic `$transaction` with `updateMany` + `createMany` in `approveBatch` (zero N+1).
- **Security:** Fixed two audit findings during implementation — (1) Express default `100kb` limit would reject valid `.gcode` payloads → scoped `12mb` strictly to `/validate-gcode` while keeping `512kb` globally against DoS; (2) `approveBatch` now validates `printerId` existence & rejects `maintenance` printers inside the transaction to prevent raw Prisma `P2003` errors.

---

## 2026-11-25 — Center-Balanced 2D Plate Packing & 15mm Thermal Margin

### Changes
- Updated `src/orders/plate-batcher.service.ts`: increased default `edgeMarginMm` from `10mm` → `15mm` (avoiding cold edges & front purge strip) and added post-packing center-balancing so every shelf row is centered horizontally and the entire group bounding box is centered on `(plateW/2, plateD/2)`.
- Updated `src/orders/plate-batcher.spec.ts` to assert center-balance within `±2mm` of bed center and `>= 15mm` edge clearance.

### Verification
- `npm run typecheck` + `npm test` → 6/6 test suites, 18/18 tests PASS.

---

## 2026-11-25 — Multi-Brand LAN Auto-Discovery (Elegoo SDCP UDP + Anycubic LAN HTTP)

### Changes
- Added `src/adapters/discovery/lan-discovery.service.ts` (+ `lan-discovery.spec.ts`) and exported via `AdaptersModule`:
  - Broadcasts Elegoo SDCP `M99999` over UDP `:3000` (255.255.255.255 + local `/24` broadcast addresses).
  - Probes Anycubic LAN Mode HTTP `:18910/info` across detected private `/24` subnet(s) with concurrency cap `32`, `280ms` per-host timeout, and hard total time budget (`<= 2.6s`).
  - Strictly validates subnets to RFC1918 private LAN ranges (`10.x`, `172.16-31.x`, `192.168.x`) only.
- Added `POST /api/printers/discover` (`@Roles('admin')`, `@RateLimit(6, 60_000)`) in `PrintersController` / `PrintersService`, cross-referencing discovered printers against PostgreSQL in 1 single query (`alreadyRegistered` + `existingPrinterId`).

### Verification & 3-Way Audit
- **Tests:** `npm run typecheck` + `npm test` → 7/7 test suites, 21/21 tests PASS.
- **Security Catch:** Unit test caught that `isAllowedPrinterIp('8.8.8.10')` permitted public IPs; tightened `normalizePrivateSubnet()` to enforce strict RFC1918 private LAN ranges only so LAN discovery can never be abused as a public internet scanner.
- **DB/N+1:** Single `prisma.printer.findMany` to tag registered vs new printers (zero N+1).
