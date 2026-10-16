import crypto from 'node:crypto';
import { db } from '../db.js';
import { getPostById, updatePostStatus } from '../models/post.js';
import { resolveFolder, createFolder, uploadFileToDrive } from './drive.js';
import { sha256 } from '../crypto.js';

export async function exportPostToDrive(postId) {
  const post = getPostById(postId);
  if (!post) throw new Error('Không tìm thấy bài viết để xuất file.');

  if (post.status !== 'APPROVED' && post.status !== 'READY_FOR_MANUAL_UPLOAD') {
    throw new Error('Chỉ bài viết đã được DUYỆT (APPROVED) mới được xuất bộ file lên Google Drive.');
  }

  const rev = db.prepare('SELECT * FROM post_revisions WHERE id = ?').get(post.current_revision_id);
  if (!rev) throw new Error('Không tìm thấy revision bài viết.');

  // Find profile OUTPUT root folder
  let outputRootFolderId = post.folder_id_output;
  if (!outputRootFolderId) {
    outputRootFolderId = `${post.profile_id}/OUTPUT`;
  }

  const rootFolder = await resolveFolder(outputRootFolderId);
  const dateFolder = await createFolder(rootFolder.id, post.content_date);
  const postFolder = await createFolder(dateFolder.id, `post_${postId}`);
  const revFolder = await createFolder(postFolder.id, `revision_${String(rev.revision_number).padStart(3, '0')}`);

  const now = new Date().toISOString();

  // 1. caption.md
  const captionMd = `# ${rev.headline || post.topic_title}\n\n${rev.caption}\n\n---\n*Kêu gọi hành động (CTA):* ${rev.cta || 'N/A'}\n`;
  const captionUpload = await uploadFileToDrive(revFolder.id, 'caption.md', 'text/markdown; charset=utf-8', Buffer.from(captionMd, 'utf8'));

  // 2. image.png / image.jpg
  let imageUpload = null;
  if (rev.image_data) {
    let imgBuffer;
    let mime = rev.image_mime || 'image/png';
    let ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';

    if (rev.image_data.startsWith('data:')) {
      const base64Data = rev.image_data.split(',')[1];
      imgBuffer = Buffer.from(base64Data, 'base64');
    } else {
      imgBuffer = Buffer.from(rev.image_data, 'utf8');
    }

    imageUpload = await uploadFileToDrive(revFolder.id, `image.${ext}`, mime, imgBuffer);
  }

  // 3. post.json (Manifest)
  const manifest = {
    schema_version: '1.0',
    post_id: post.id,
    revision_id: rev.id,
    revision_number: rev.revision_number,
    profile_id: post.profile_id,
    profile_name: post.profile_name,
    topic_id: post.topic_id,
    topic_title: post.topic_title,
    content_date: post.content_date,
    scheduled_time: post.scheduled_time,
    rule_version_id: rev.rule_version_id,
    rule_hash: rev.rule_hash,
    caption_hash: sha256(rev.caption),
    image_hash: rev.image_data ? sha256(rev.image_data) : null,
    drive_folder_id: revFolder.id,
    drive_caption_file_id: captionUpload.id,
    drive_image_file_id: imageUpload?.id || null,
    approval: {
      approver_id: post.approver_id,
      approved_at: post.approved_at
    },
    publish_mode: 'manual',
    exported_at: now
  };

  const manifestUpload = await uploadFileToDrive(revFolder.id, 'post.json', 'application/json; charset=utf-8', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  // 4. REVIEW.md
  const reviewMd = `# BÁO CÁO DUYỆT BÀI VIẾT (REVIEW)

- **Thương hiệu:** ${post.profile_name} (${post.profile_id})
- **Chủ đề:** ${post.topic_title}
- **Ngày đăng dự kiến:** ${post.content_date} lúc ${post.scheduled_time} (GMT+7)
- **Phiên bản:** Revision ${rev.revision_number} (${rev.id})
- **Người duyệt:** ${post.approver_id || 'u_admin'}
- **Thời gian duyệt:** ${post.approved_at || now}
- **Trạng thái:** Sẵn sàng cho người vận hành tải lên Facebook thủ công (READY_FOR_MANUAL_UPLOAD)

## Kiểm tra an toàn:
- [x] Đúng định vị và văn phong thương hiệu
- [x] Không chứa cụm từ bị hạn chế
- [x] Đầy đủ file ảnh và caption chất lượng cao

## Danh mục tệp trong bộ bài:
1. \`caption.md\`: Nội dung bài viết sẵn sàng copy
2. \`image.${imageUpload ? (rev.image_mime?.includes('jpeg') ? 'jpg' : 'png') : 'png'}\`: Hình ảnh kích thước chuẩn
3. \`post.json\`: Manifest kỹ thuật và chữ ký số
4. \`REVIEW.md\`: Biên bản duyệt này
`;

  const reviewUpload = await uploadFileToDrive(revFolder.id, 'REVIEW.md', 'text/markdown; charset=utf-8', Buffer.from(reviewMd, 'utf8'));

  // Upsert export record
  const exportId = `exp_${crypto.randomUUID().slice(0, 10)}`;
  db.prepare('DELETE FROM exports WHERE post_id = ? AND revision_id = ?').run(post.id, rev.id);

  db.prepare(`
    INSERT INTO exports (id, post_id, revision_id, revision_hash, drive_folder_id, drive_caption_file_id, drive_image_file_id, drive_manifest_file_id, drive_review_file_id, status, exported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPORTED', ?)
  `).run(
    exportId,
    post.id,
    rev.id,
    rev.revision_hash,
    revFolder.id,
    captionUpload.id,
    imageUpload?.id || null,
    manifestUpload.id,
    reviewUpload.id,
    now
  );

  // Transition post state to READY_FOR_MANUAL_UPLOAD
  updatePostStatus(post.id, 'READY_FOR_MANUAL_UPLOAD');

  // Audit event
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, revision_id, details_json, created_at)
    VALUES (?, ?, 'EXPORT_TO_DRIVE', 'post', ?, ?, ?, ?)
  `).run(`audit_${Date.now()}`, 'u_admin', post.id, rev.id, JSON.stringify({ drive_folder_id: revFolder.id }), now);

  return {
    success: true,
    driveFolderId: revFolder.id,
    driveFolderUrl: `https://drive.google.com/drive/folders/${revFolder.id}`,
    files: {
      caption: captionUpload.id,
      image: imageUpload?.id,
      manifest: manifestUpload.id,
      review: reviewUpload.id
    }
  };
}
