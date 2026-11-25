# AGENTS.md — Backend Repo (Print Farm API)

1. **Đọc ngữ cảnh trước khi làm:** Mỗi phiên/model mới PHẢI đọc [docs/WORKFLOW_HISTORY.md](docs/WORKFLOW_HISTORY.md) và [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) trước khi sửa code.
2. **Ghi log sau mỗi Task:** Cập nhật [docs/WORKFLOW_HISTORY.md](docs/WORKFLOW_HISTORY.md) sau mỗi task (đã làm gì, file đổi, kết quả Audit 3 chiều, trạng thái hiện tại) và cập nhật [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) nếu kiến trúc/schema/adapter/port thay đổi.
3. **Audit 3 chiều bắt buộc sau mỗi Task:**
   - **Hiệu suất:** Event-loop, WebSocket throttle/batching, timer/listener cleanup.
   - **Database & N+1:** Eager loading/JOIN/batch query, composite index, không query trong vòng lặp.
   - **Bảo mật:** SSRF/IPv4 guard, AES-256-GCM credentials, Zod validation, không lộ secret qua API/log.
4. **Quy tắc an toàn Port:** Mọi port cấu hình qua `.env` và bắt đầu từ **`6000+`**. Trước khi mở port, kiểm tra xem port có đang bị chiếm dụng không (`Get-NetTCPConnection`). Nếu bận, **TUYỆT ĐỐI KHÔNG tự ý kill process đó** — báo dev xác nhận đổi port khác.
5. **Kiến trúc Brand Adapter:** Adapter gom theo **tên hãng** (`src/adapters/<brand>/drivers/<model>/`). Mỗi máy in giữ tối đa 1 kết nối MQTT vật lý.
6. **An toàn phần cứng:** Không gửi lệnh ghi tới máy in thật để test tự động. `startPrint` bắt buộc kiểm tra `bedStatus === 'clean'`.
