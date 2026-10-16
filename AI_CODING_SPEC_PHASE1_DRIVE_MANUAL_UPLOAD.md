# THE HBG CONTENT STUDIO — Đặc tả triển khai cho AI coding

Phiên bản: 1.0 · Ngày chốt: 09/10/2026  
Phạm vi: Google Drive → tạo caption và ảnh thật → kiểm tra → duyệt → lưu bộ bài → chờ đăng thủ công.  
Ngôn ngữ giao diện: tiếng Việt. Timezone mặc định: `Asia/Ho_Chi_Minh`.

## 1. Cách dùng tài liệu

Đưa toàn bộ file này cho coding agent cùng source hiện tại. Đây là đặc tả hành vi, điều kiện hoàn thành và kế hoạch kiểm thử; không phải báo cáo tính năng đã triển khai.

Agent phải đọc repository và tài liệu dự án trước, đối chiếu từng yêu cầu với code thật, sau đó triển khai theo thứ tự các bước ở mục 12. Không báo hoàn thành chỉ vì đã có giao diện, nút bấm hoặc mock response. Mỗi bước phải có bằng chứng kiểm thử, các hạn chế và hướng dẫn chạy.

Quyết định mới trong file này thay thế phần mâu thuẫn của `PROJECT_PHASE_1.md`: không cần Meta để hoàn thành đợt này; không dùng S3/R2 làm điều kiện chạy; Drive là nơi lưu file nguồn và file kết quả; đích cuối là chờ đăng thủ công. Những nguyên tắc cũ về snapshot, bảo vệ secret, version, kiểm thử và audit vẫn giữ nếu phù hợp.

### 1.1 Hiện trạng cần xác minh

Bản prototype từng bàn giao là static frontend, lưu dữ liệu bằng localStorage, chưa có backend, OAuth thật, database hay AI generation thật. Người dùng mở giao diện tại `http://localhost:8080/#settings`. Không giả định source hiện tại vẫn giống prototype: người dùng có thể đã bổ sung backend trên máy riêng.

Port backend `3000` và callback `/api/oauth/google/callback` là cấu hình dự kiến. Agent phải kiểm tra code trước khi đưa lệnh chạy hoặc yêu cầu thay OAuth console. Không tự sửa callback theo phỏng đoán.

### 1.2 Định nghĩa thành công của đợt này

Một người vận hành có thể kết nối Google, gắn folder thật, đồng bộ một topic đủ dữ liệu, tạo caption/ảnh bằng provider thật, sửa và duyệt revision hiện tại. Ứng dụng lưu đủ caption, ảnh và manifest vào đúng OUTPUT trên Drive, sau đó hiển thị `READY_FOR_MANUAL_UPLOAD` với copy caption, tải ảnh, mở folder. Restart server không mất bài, không cần tạo lại ảnh và không upload file trùng khi retry bình thường.

Không gọi API Meta, không tự đăng Facebook, không yêu cầu Meta App ID/Secret để khởi động. Giao diện không báo “Đã đăng” nếu chỉ mới xuất file.

## 2. Phạm vi và giới hạn

### 2.1 Bắt buộc có

- Profile cấu hình độc lập: thương hiệu, sản phẩm, ngôn ngữ, rule, folder, image preset.
- Backend/API, database bền vững, xác thực người dùng và kiểm tra quyền phía server.
- OAuth Google phía server; kiểm tra quyền đọc nguồn và ghi OUTPUT.
- Đọc rule Markdown, topic Google Sheets và ảnh PNG/JPEG/WebP từ Drive.
- Preview source, snapshot rule/topic/facts/assets cho từng revision.
- Tạo caption thật, tạo/chỉnh ảnh thật, có tùy chọn upload ảnh hoàn chỉnh thủ công.
- Caption editor, preview ảnh final, validator findings, submit review, request changes, approve.
- Xuất bộ file lên Drive, phục hồi lỗi xuất, giao diện đăng thủ công.
- Lưu lịch dự kiến đăng, người duyệt, lịch sử chỉnh sửa, chi phí/usage nếu provider trả.
- Hướng dẫn cài đặt, cấu hình, chạy, kiểm thử và vận hành.

### 2.2 Không làm trong đợt này

Meta OAuth, Page tokens, publish worker, tự đăng/lên lịch trên Facebook, trình duyệt tự đăng bằng cookie, analytics, Reels/video/carousel, đa nền tảng. Không tạo cron chạy hàng loạt mặc định. MVP có nút tạo bài theo yêu cầu; tự tạo hằng ngày là P1 tùy chọn sau khi luồng một bài ổn định.

Nội dung nhiều ngôn ngữ có thể hỗ trợ vi/en/vi-en nếu profile có rule. Một bài gồm caption và một ảnh final. Không tự xây lại toàn bộ UI hoặc đổi framework nếu có thể nối backend vào source hiện tại.

## 3. Kiến trúc và tiêu chuẩn chung

### 3.1 Lựa chọn stack

Giữ stack đã tồn tại nếu đáp ứng yêu cầu. Nếu chỉ có static frontend, mặc định đề xuất TypeScript frontend/backend, PostgreSQL, một worker xử lý công việc dài. Chọn một runtime Node LTS còn được hỗ trợ và kiểm tra tương thích dependency khi triển khai; pin bằng lockfile và ghi rõ trong README. Không áp đặt số phiên bản chưa kiểm chứng.

Queue nhỏ có thể dùng bảng jobs và atomic lease trong PostgreSQL để giảm dependency. Nếu repository đã có BullMQ/Redis thì dùng lại, nhưng DB vẫn giữ trạng thái authoritative. Worker có thể là process riêng; không phụ thuộc tab trình duyệt còn mở.

### 3.2 Ranh giới module

| Module | Trách nhiệm |
|---|---|
| Auth/RBAC | Login, session, kiểm tra user/workspace/profile |
| Profiles | Cấu hình folder, rule, policy, image preset |
| Google connection | OAuth, token encryption, refresh, reconnect |
| Drive adapter | List/download/export/create/update file trong scope cho phép |
| Topic adapter | Đọc bảng, chuẩn hóa row, validation, source revision |
| Rules | Import, version, publish, conflict handling |
| Generation | Text/image provider adapter, input/output schema, budget |
| Image compositor | Crop/resize và lớp logo/text xác định |
| Posts/Review | Revision, trạng thái, approval bất biến |
| Export | Xuất bộ bài, manifest, retry và reconcile |
| Audit/Operations | Log đã redaction, timeline, recovery |

Domain không phụ thuộc trực tiếp SDK provider. Có interface để dùng fixture trong test, adapter thật trong runtime. Mock và thật phải có nhãn rõ, không âm thầm fallback sang caption mẫu khi provider lỗi.

### 3.3 Quy tắc dữ liệu/code

- Validation tại API boundary bằng schema; frontend validation không thay server validation.
- Migration có version, foreign key, unique constraint; không dùng localStorage làm database production.
- Event time lưu UTC, hiển thị timezone profile; `content_date` là ngày local, không convert thành ngày UTC.
- File và số liệu provider là dữ liệu không đáng tin mặc định: giới hạn MIME, kích thước, timeout và schema.
- Không hard-code tên thương hiệu trong domain bằng if/else; đưa chính sách vào profile/rule.
- API trả error code ổn định, message tiếng Việt rõ và request ID; không trả stack chứa secret.
- Không nuốt lỗi và đổi sang trạng thái thành công. Long-running operation trả operation/job ID để UI theo dõi.
- Dependency pin, format/lint/typecheck/build phải chạy được bằng script đã ghi trong README.
- Phân tách dev/staging/production và test không chạm folder sản xuất mặc định.

## 4. Cấu hình và secrets

### 4.1 Biến môi trường đề xuất

```dotenv
APP_ENV=development
FRONTEND_ORIGIN=http://localhost:8080
API_PORT=8080
DATABASE_URL=sqlite:./data/content_studio.db
GOOGLE_CLIENT_ID=REPLACE_ME
GOOGLE_CLIENT_SECRET=REPLACE_WITH_SERVER_SECRET
GOOGLE_REDIRECT_URI=http://localhost:8080/api/oauth/google/callback
TOKEN_ENCRYPTION_KEY=REPLACE_WITH_64_HEX_CHARACTERS
AUTH_SECRET=REPLACE_WITH_RANDOM_SERVER_SECRET
OPENAI_API_KEY=REPLACE_WITH_SERVER_SECRET
TEXT_MODEL=gpt-4o-mini
IMAGE_MODEL=dall-e-3
DEFAULT_TIMEZONE=Asia/Ho_Chi_Minh
PUBLISH_MODE=manual
DRIVE_OUTPUT_REQUIRED=true
```

## 5. Ranh giới phase tiếp theo
Meta integration và Auto publish worker sẽ thực hiện ở phase tiếp theo sau khi workflow Google Drive + duyệt + xuất file và đăng thủ công hoàn thành ổn định.
