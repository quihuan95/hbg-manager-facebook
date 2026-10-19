# HBG Content Studio Desktop

## Chạy thử Electron

```powershell
npm install
npm run electron
```

Trong chế độ phát triển, ứng dụng tiếp tục dùng `.env` hiện có, nhưng lưu database trong thư mục dữ liệu Electron.

## Tạo bộ cài Windows

```powershell
npm run build:win
```

Bộ cài được tạo trong thư mục `release`. Database của bản đã cài đặt nằm tại:

```text
%APPDATA%\HBG Content Studio\data\content_studio.sqlite
```

File cấu hình nằm tại:

```text
%APPDATA%\HBG Content Studio\.env
```

Lần chạy đầu tiên, ứng dụng tạo file này từ `.env.example`. Toàn bộ cấu hình có thể nhập tại màn hình **Cài đặt & Kết nối** trong ứng dụng. Trường bí mật không được trả lại giao diện; để trống khi lưu sẽ giữ nguyên giá trị cũ. Khởi động lại ứng dụng sau khi thay đổi cấu hình.

Google OAuth callback cho bản desktop:

```text
http://127.0.0.1:8080/api/oauth/google/callback
```

Callback này phải được thêm vào danh sách Authorized redirect URIs trong Google Cloud Console.
