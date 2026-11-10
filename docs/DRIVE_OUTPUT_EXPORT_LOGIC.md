# Logic xuất bài ra Google Drive OUTPUT

Tài liệu này mô tả đúng luồng đang được cài đặt trong `src/google/export.js`, `src/google/drive.js`, `server.js` và `src/automation.js`.

## 1. Mục tiêu

Sau khi bài viết được duyệt, hệ thống xuất revision hiện tại thành một bộ file trong thư mục `OUTPUT` của Content Profile. Bộ file là đầu ra để người vận hành kiểm tra, lấy caption/ảnh và đăng thủ công.

Khi xuất thành công:

- kết quả Drive được lưu vào bảng `exports`;
- trạng thái bài chuyển thành `READY_FOR_MANUAL_UPLOAD`;
- hệ thống ghi audit event `EXPORT_TO_DRIVE`;
- API trả về link thư mục revision trên Google Drive.

## 2. Điểm kích hoạt export

### Duyệt thủ công

`POST /api/posts/:postId/approve` duyệt bài trước, sau đó gọi `exportPostToDrive(postId)`. Nếu Drive lỗi, bài vẫn giữ trạng thái `APPROVED`; người dùng có thể export lại mà không phải duyệt hoặc sinh nội dung lại.

### Export lại từ giao diện

`POST /api/posts/:postId/export` gọi trực tiếp `exportPostToDrive(postId)`. Nút **Xuất lên Google Drive (OUTPUT)** trên giao diện sử dụng endpoint này.

### Automation

- Với bài đã ở trạng thái `APPROVED`, automation chỉ retry bước export.
- Với workflow tự động, hệ thống duyệt bài rồi export ngay.
- Bài đã `READY_FOR_MANUAL_UPLOAD` hoặc `MANUALLY_UPLOADED` được bỏ qua, không export lại trong lượt automation thông thường.

## 3. Điều kiện đầu vào

Một bài chỉ được export khi thỏa tất cả điều kiện sau:

1. Bài tồn tại.
2. Trạng thái là `APPROVED` hoặc `READY_FOR_MANUAL_UPLOAD`.
3. `current_revision_id` trỏ đến một revision còn tồn tại.
4. Google OAuth còn hiệu lực và có quyền ghi vào thư mục OUTPUT.
5. Profile có `folder_id_output`, hoặc đường dẫn dự phòng `<profile_id>/OUTPUT` tồn tại trên My Drive.
6. Dữ liệu ảnh của revision đọc được từ vùng media local.

## 4. Cấu trúc thư mục Drive

Hệ thống tạo hoặc tái sử dụng cây thư mục:

```text
<folder_id_output>/
└── DD-MM-YYYY/
    └── <topic_title>/
        └── v<revision_number>/
            ├── caption.md
            ├── image.png              # nếu chỉ có một ảnh PNG
            ├── image.jpg              # nếu chỉ có một ảnh JPEG
            ├── image-01.png            # nếu có nhiều ảnh
            ├── image-02.jpg
            ├── post.json
            └── REVIEW.md
```

Quy tắc đặt tên:

- Ngày từ `YYYY-MM-DD` được đổi thành `DD-MM-YYYY`.
- Dấu `/` và `\` trong tiêu đề được đổi thành ` - `.
- Ký tự điều khiển bị loại bỏ, khoảng trắng được chuẩn hóa.
- Tên chủ đề dài tối đa 120 ký tự.
- Mỗi revision có thư mục riêng `v1`, `v2`, ...

`createFolder()` tìm thư mục cùng tên trong đúng thư mục cha trước khi tạo mới. Vì vậy retry bình thường sẽ tái sử dụng cây thư mục cũ.

## 5. Nội dung bộ file

### `caption.md`

Chứa:

- headline, hoặc topic title nếu headline trống;
- caption hoàn chỉnh;
- CTA ở cuối file.

### File ảnh

Nguồn ưu tiên là `post_revisions.image_set_json`. Revision cũ chưa có image set sẽ dùng `image_data` và `image_mime`.

- Một ảnh: `image.png` hoặc `image.jpg`.
- Nhiều ảnh: `image-01.png`, `image-02.jpg`, ...
- MIME JPEG tạo đuôi `.jpg`; các MIME ảnh còn lại hiện được xuất với đuôi `.png`.

### `post.json`

Manifest kỹ thuật gồm:

- schema version;
- post, revision, profile và topic ID;
- ngày và giờ dự kiến đăng;
- rule version và rule hash;
- SHA-256 của caption và ảnh;
- danh sách ảnh cùng Drive file ID, tên file, brief và source file ID;
- Drive folder/file ID;
- thông tin người duyệt và thời gian duyệt;
- `publish_mode: "manual"`;
- thời gian export.

### `REVIEW.md`

Biên bản duyệt dành cho người vận hành, gồm thông tin thương hiệu, chủ đề, lịch đăng, revision, người duyệt, trạng thái và danh sách file trong bộ bài.

## 6. Trình tự xử lý

```text
Nhận postId
  → chặn export đồng thời cùng postId
  → đọc bài và revision hiện tại
  → kiểm tra trạng thái
  → resolve thư mục OUTPUT
  → tạo/tái sử dụng thư mục ngày, chủ đề, revision
  → upload caption
  → upload toàn bộ ảnh
  → tạo và upload post.json
  → tạo và upload REVIEW.md
  → kiểm tra lại post/revision trong transaction SQLite
  → ghi exports + cập nhật trạng thái + ghi audit
  → trả Drive folder URL
```

## 7. Idempotency và chống xung đột

### Upload file

`uploadFileToDrive()` tìm file theo `parent folder + file name`:

- đã tồn tại: cập nhật bằng `PATCH` và giữ file ID;
- chưa tồn tại: tạo bằng `POST`.

Retry cùng revision vì vậy không tạo thêm bản sao trong trường hợp bình thường.

### Export đồng thời

`activeExportPostIds` chặn hai lượt export cùng một `postId` trong cùng process. Lượt thứ hai nhận lỗi `EXPORT_IN_PROGRESS`. Trong thời gian export, API xóa bài cũng trả HTTP 409.

### Revision thay đổi trong lúc upload

Sau khi upload xong, hệ thống mở `BEGIN IMMEDIATE` và kiểm tra lại:

- bài vẫn tồn tại;
- revision vẫn thuộc bài;
- `current_revision_id` vẫn đúng revision vừa export.

Nếu revision đã đổi, transaction local bị rollback và trả `EXPORT_REVISION_CONFLICT`. Người dùng phải export revision mới nhất.

## 8. Ghi dữ liệu local khi thành công

Trong một transaction SQLite, hệ thống:

1. Xóa bản ghi export cũ của cùng `post_id + revision_id`.
2. Thêm bản ghi mới vào `exports` với trạng thái `EXPORTED` và các Drive ID.
3. Cập nhật `posts.status = READY_FOR_MANUAL_UPLOAD`.
4. Ghi `audit_events.action = EXPORT_TO_DRIVE`.

Transaction giúp dữ liệu local không rơi vào trạng thái ghi dở dang.

## 9. Xử lý lỗi và retry

- Lỗi OAuth, quyền Drive, không tìm thấy OUTPUT, upload hoặc đọc ảnh sẽ dừng export và trả lỗi cho caller.
- Nếu lỗi xảy ra sau khi bài đã được duyệt, bài giữ `APPROVED`; lần chạy sau chỉ cần retry export.
- File đã upload trước lúc lỗi có thể còn trên Drive. Lần retry sẽ cập nhật file cùng tên thay vì tạo bản sao.
- Nếu upload Drive đã hoàn tất nhưng transaction local thất bại, các file Drive vẫn còn; retry sẽ reconcile bằng cách upload/update lại rồi ghi DB.
- Khóa `activeExportPostIds` luôn được giải phóng trong `finally`, kể cả khi export lỗi.

## 10. Kết quả API

Kết quả thành công có dạng:

```json
{
  "success": true,
  "driveFolderId": "drive-folder-id",
  "driveFolderUrl": "https://drive.google.com/drive/folders/drive-folder-id",
  "files": {
    "caption": "caption-file-id",
    "image": "first-image-file-id",
    "images": ["image-file-id-1", "image-file-id-2"],
    "manifest": "manifest-file-id",
    "review": "review-file-id"
  }
}
```

## 11. Giới hạn hiện tại

- Khóa chống export đồng thời chỉ nằm trong memory của một process, chưa phải distributed lock.
- Drive API hiện chưa truyền các tham số hỗ trợ Shared Drive như `supportsAllDrives` và `includeItemsFromAllDrives`.
- Khi tìm thấy nhiều folder/file trùng tên, adapter dùng kết quả đầu tiên từ Drive API.
- Google Drive upload không nằm trong cùng transaction với SQLite; rollback DB không thể tự xóa các file đã upload.
- Bảng `exports` chỉ lưu ID ảnh đầu tiên ở `drive_image_file_id`; danh sách đầy đủ nằm trong `post.json` và response API.
- Giao diện còn dùng cụm từ “4 tệp”, nhưng một bài nhiều ảnh thực tế có thể tạo hơn 4 file.

## 12. File code liên quan

- `src/google/export.js`: điều phối toàn bộ export và ghi nhận kết quả.
- `src/google/drive.js`: resolve folder, tạo folder và upload idempotent.
- `server.js`: endpoint approve, export và chặn xóa khi đang export.
- `src/automation.js`: export tự động và retry riêng bước Drive.
- `src/models/post.js`: lấy post cùng revision/export hiện tại.
- `src/db.js`: schema bảng `exports`, `posts` và `audit_events`.
- `dist/app.js`: nút export và hiển thị link thư mục Drive.
