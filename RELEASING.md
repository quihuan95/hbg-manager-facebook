# Phát hành HBG Content Studio

Ứng dụng desktop kiểm tra bản cập nhật từ GitHub Releases của repository
`quihuan95/hbg-manager-facebook`. Chỉ bản cài đặt NSIS hỗ trợ tự động cập nhật;
bản portable và chế độ phát triển không tự cập nhật.

## Tạo bản phát hành

1. Cập nhật trường `version` trong `package.json` và `package-lock.json`:

   ```powershell
   npm version patch --no-git-tag-version
   ```

2. Commit và đẩy mã nguồn lên nhánh chính.
3. Tạo tag trùng với phiên bản trong `package.json`, có tiền tố `v`:

   ```powershell
   git tag v1.3.9
   git push origin v1.3.9
   ```

GitHub Actions sẽ chạy test, tạo bộ cài Windows và xuất bản Release gồm file
NSIS, blockmap và `latest.yml`. Máy đang cài ứng dụng sẽ kiểm tra bản mới sau
khi khởi động; người dùng cũng có thể kiểm tra trong **Cài đặt & Kết nối**.

Không tạo lại cùng một số phiên bản. Nếu cần sửa một Release lỗi, hãy tăng số
phiên bản rồi phát hành tag mới.
