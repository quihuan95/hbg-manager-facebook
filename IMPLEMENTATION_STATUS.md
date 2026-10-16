# Báo cáo Hiện trạng & Kế hoạch Triển khai (IMPLEMENTATION_STATUS)

**Dự án:** The HBG Content Studio — Phase 1 (Google Drive → Tạo nội dung AI → Duyệt → Xuất OUTPUT Drive → Chờ đăng thủ công)  
**Ngày cập nhật:** 09/10/2026  
**Chủ dự án:** Minh Phạm  
**Trạng thái:** ✅ Đã hoàn thành toàn bộ 10 bước theo đặc tả Phase 1.

---

## 1. Ma trận hiện trạng tính năng

| Hạng mục / Yêu cầu | Hiện trạng | Module / File | Kiểm thử & Xác minh |
|---|---|---|---|
| **Auth / RBAC & Session** | Hoàn thành | `src/auth.js`, `server.js` | Session token, RBAC Admin/Editor/Approver |
| **Durable Database** | Hoàn thành | `src/db.js`, `data/content_studio.sqlite` | WAL mode, foreign keys, 14 bảng dữ liệu bền vững |
| **OAuth Google & Token Encryption** | Hoàn thành | `src/google/oauth.js`, `src/crypto.js` | AES-256-GCM 32-byte encryption, CSRF state protection |
| **Drive Adapter (Read & Write Probe)** | Hoàn thành | `src/google/drive.js` | List, read, create folder, probe write test |
| **Profile & Rule Versioning** | Hoàn thành | `src/models/profile.js`, `src/models/rule.js` | Immutable versioning, SHA-256 hashing |
| **Topic Sheet Sync** | Hoàn thành | `src/google/sheets.js` | Đồng bộ tab TOPICS, chuẩn hóa row, chống duplicate |
| **Post Revisions & State Machine** | Hoàn thành | `src/models/post.js` | 6 trạng thái workflow, optimistic locking `expectedRevisionId` |
| **Caption Generation (OpenAI)** | Hoàn thành | `src/ai/caption.js` | Structured JSON output (`gpt-4o-mini`), fact/claim checks |
| **Image Generator & Upload** | Hoàn thành | `src/ai/image.js` | DALL-E 3 (`dall-e-3`), upload file PNG/JPEG/WebP |
| **Review & Approval Workflow** | Hoàn thành | `src/review/approval.js` | Check blockers, exact revision hash audit, revoke on edit |
| **Export Drive Bộ 4 files** | Hoàn thành | `src/google/export.js` | `caption.md`, `image.png`, `post.json`, `REVIEW.md` |
| **Chờ đăng thủ công & Audit** | Hoàn thành | `src/manual_upload.js`, `dist/app.js` | Copy caption, tải ảnh, mở Drive, xác nhận Facebook post |

---

## 2. Nhật ký Vertical Slice (10 Bước)

- [x] **Bước 0:** Audit source, chốt gaps và lập `IMPLEMENTATION_STATUS.md`.
- [x] **Bước 1:** Bootstrap backend module hóa, Database bền vững (`node:sqlite`), auth/RBAC session, config schema.
- [x] **Bước 2:** Google OAuth server-side, mã hóa token AES-256-GCM, Drive list/read/probe write.
- [x] **Bước 3:** Profile manager, Rule versioning bất biến, Topic Google Sheet synchronizer.
- [x] **Bước 4:** Post revisions state machine & durable operations.
- [x] **Bước 5:** Caption generation với structured JSON schema, Claims/Facts validator & Budget tracking.
- [x] **Bước 6:** Image generator DALL-E 3 & Manual upload path.
- [x] **Bước 7:** Review & Approval với exact revision hash, optimistic locking & audit logs.
- [x] **Bước 8:** Xuất bộ 4 files (`caption.md`, `image.png`, `post.json`, `REVIEW.md`) lên Google Drive, Idempotent retry.
- [x] **Bước 9:** Giao diện Chờ đăng thủ công (`READY_FOR_MANUAL_UPLOAD`), Copy caption, Tải ảnh & Xác nhận đăng.
- [x] **Bước 10:** Hardening, chạy bộ test matrix P0, E2E integration test đạt 100%.
