# The HBG Content Studio — Phase 1 (Production Backend & Manual Upload)

Hệ thống quản lý quy trình sáng tạo và phê duyệt nội dung đa thương hiệu (The HBG M.I.C.E, The HBG Tourist, Danang Events, HCMC Events).

## 🚀 Khởi chạy hệ thống

```bash
# Cài đặt / Chạy trực tiếp qua Node.js (v22+)
npm start
# hoặc
node server.js
```

Mở trình duyệt: **[http://localhost:8080](http://localhost:8080)**

---

## 🛠 Tính năng đã hoàn thiện (Phase 1)

1. **Cơ sở dữ liệu bền vững (SQLite):**
   - Lưu trữ toàn bộ Profile, Rule Versions, Topic Sheets, Post Revisions, Approvals, Exports, Manual Uploads và Audit Logs tại `data/content_studio.sqlite`.
   - Dữ liệu tồn tại vĩnh viễn qua các lần restart server.

2. **Kết nối Google Drive / Google Sheets:**
   - Xác thực OAuth 2.0 (`/api/oauth/google/start` và callback).
   - Mã hóa AES-256-GCM token trên server với `TOKEN_ENCRYPTION_KEY`.
   - Tự động đồng bộ Topics từ Google Sheet tab `TOPICS`.
   - Xuất trọn bộ 4 files (`caption.md`, `image.png`, `post.json`, `REVIEW.md`) vào thư mục `OUTPUT` trên Drive.

3. **Tạo nội dung AI chuẩn thương hiệu:**
   - **Text Model:** `gpt-4o-mini` tạo caption có cấu trúc JSON, headline, CTA và tự động áp dụng Rule nghiêm ngặt của từng thương hiệu.
   - **Image Model:** `dall-e-3` tạo hình ảnh sự kiện chất lượng cao (hoặc tải ảnh hoàn chỉnh từ máy).

4. **Quy trình Phê duyệt & Đăng thủ công (Manual Upload Workflow):**
   - Vòng đời: `DRAFT` $\rightarrow$ `GENERATING` $\rightarrow$ `NEEDS_REVIEW` $\rightarrow$ `APPROVED` $\rightarrow$ `READY_FOR_MANUAL_UPLOAD` $\rightarrow$ `MANUALLY_UPLOADED`.
   - Quản lý phiên bản bất biến (`revision_hash`), tự động hủy duyệt nếu sửa nội dung.
   - Giao diện đăng thủ công: Nút sao chép toàn bộ Caption, tải ảnh Final độ phân giải cao, mở trực tiếp thư mục Drive và form xác nhận kèm link Facebook post.

---

## 📂 Tài liệu dự án

- `AI_CODING_SPEC_PHASE1_DRIVE_MANUAL_UPLOAD.md`: Bản đặc tả chi tiết Phase 1.
- `IMPLEMENTATION_STATUS.md`: Báo cáo hiện trạng và kết quả kiểm thử.
- `.env`: Cấu hình môi trường (OpenAI Key, Google OAuth, Timezone, Encryption Key).
