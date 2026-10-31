import crypto from 'node:crypto';
import { db } from '../db.js';
import { getPostById } from '../models/post.js';
import { resolveFolder, createFolder, uploadFileToDrive } from './drive.js';
import { sha256 } from '../crypto.js';
import { readMediaBuffer } from '../media.js';

function driveFolderName(value, maxLength = 120) {
  const name = String(value || 'Bài viết')
    .replace(/[\\/]+/g, ' - ')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return name || 'Bài viết';
}

function driveDateFolderName(contentDate) {
  const match = String(contentDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : driveFolderName(contentDate || 'Chưa xác định ngày');
}

const activeExportPostIds = new Set();

export function isPostExporting(postId) {
  return activeExportPostIds.has(postId);
}

async function performPostExport(postId) {
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
  const dateFolder = await createFolder(rootFolder.id, driveDateFolderName(post.content_date));
  const postFolder = await createFolder(dateFolder.id, driveFolderName(post.topic_title));
  const revFolder = await createFolder(postFolder.id, `v${rev.revision_number}`);

  const now = new Date().toISOString();

  // 1. caption.md
  const captionMd = `# ${rev.headline || post.topic_title}\n\n${rev.caption}\n\n---\n*Kêu gọi hành động (CTA):* ${rev.cta || 'N/A'}\n`;
  const captionUpload = await uploadFileToDrive(revFolder.id, 'caption.md', 'text/markdown; charset=utf-8', Buffer.from(captionMd, 'utf8'));

  // 2. Export every image. Legacy revisions still contain one image_data value.
  let imageSet = [];
  try { imageSet = JSON.parse(rev.image_set_json || '[]'); } catch {}
  if (!imageSet.length && rev.image_data) imageSet = [{ data: rev.image_data, mime: rev.image_mime || 'image/png' }];
  const imageUploads = [];
  for (let index = 0; index < imageSet.length; index++) {
    const item = imageSet[index];
    const mime = item.mime || 'image/png';
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
    const imgBuffer = readMediaBuffer(item.data);
    if (!imgBuffer) throw new Error(`Không đọc được file ảnh số ${index + 1} trong thư mục dữ liệu ứng dụng.`);
    const fileName = imageSet.length === 1 ? `image.${ext}` : `image-${String(index + 1).padStart(2, '0')}.${ext}`;
    const upload = await uploadFileToDrive(revFolder.id, fileName, mime, imgBuffer);
    imageUploads.push({ ...upload, fileName, brief: item.brief || null, sourceFileId: item.sourceFileId || null });
  }
  const imageUpload = imageUploads[0] || null;

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
    image_hash: imageSet[0]?.data ? sha256(imageSet[0].data) : null,
    images: imageUploads.map((upload, index) => ({ drive_file_id: upload.id, file_name: upload.fileName, hash: sha256(imageSet[index].data), brief: upload.brief, source_file_id: upload.sourceFileId })),
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

## Kiểm tra chất lượng:
- [x] Đúng định vị và văn phong thương hiệu theo Rule
- [x] Đầy đủ file ảnh và caption chất lượng cao

## Danh mục tệp trong bộ bài:
1. \`caption.md\`: Nội dung bài viết sẵn sàng copy
2. ${imageUploads.length ? imageUploads.map(upload => `\`${upload.fileName}\``).join(', ') : '`image.png`'}: Toàn bộ hình ảnh của bài viết, mỗi ảnh đã được lồng khung
3. \`post.json\`: Manifest kỹ thuật và chữ ký số
4. \`REVIEW.md\`: Biên bản duyệt này
`;

  const reviewUpload = await uploadFileToDrive(revFolder.id, 'REVIEW.md', 'text/markdown; charset=utf-8', Buffer.from(reviewMd, 'utf8'));

  // Persist the local export result atomically. Google uploads above can take
  // several minutes, during which a profile sync or manual edit may remove the
  // post or advance its revision. Revalidate the parents while holding the
  // SQLite write lock so a generic FOREIGN KEY failure cannot occur midway.
  const exportId = `exp_${crypto.randomUUID().slice(0, 10)}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT current_revision_id FROM posts WHERE id = ?').get(post.id);
    if (!current) {
      throw new Error(`EXPORT_PARENT_MISSING: Bài viết ${post.id} đã bị xóa trong lúc tải file lên Drive.`);
    }
    const revisionExists = db.prepare('SELECT 1 AS ok FROM post_revisions WHERE id = ? AND post_id = ?').get(rev.id, post.id);
    if (!revisionExists) {
      throw new Error(`EXPORT_REVISION_MISSING: Revision ${rev.id} không còn tồn tại.`);
    }
    if (current.current_revision_id !== rev.id) {
      throw new Error('EXPORT_REVISION_CONFLICT: Bài viết đã có revision mới trong lúc tải file lên Drive. Hãy xuất lại revision mới nhất.');
    }

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
    db.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?')
      .run('READY_FOR_MANUAL_UPLOAD', now, post.id);
    db.prepare(`
      INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, revision_id, details_json, created_at)
      VALUES (?, ?, 'EXPORT_TO_DRIVE', 'post', ?, ?, ?, ?)
    `).run(`audit_${crypto.randomUUID().slice(0, 12)}`, 'u_admin', post.id, rev.id, JSON.stringify({ drive_folder_id: revFolder.id }), now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    success: true,
    driveFolderId: revFolder.id,
    driveFolderUrl: `https://drive.google.com/drive/folders/${revFolder.id}`,
    files: {
      caption: captionUpload.id,
      image: imageUpload?.id,
      images: imageUploads.map(upload => upload.id),
      manifest: manifestUpload.id,
      review: reviewUpload.id
    }
  };
}

export async function exportPostToDrive(postId) {
  if (activeExportPostIds.has(postId)) {
    throw new Error('EXPORT_IN_PROGRESS: Bài viết đang được xuất lên Google Drive. Vui lòng chờ hoàn tất.');
  }
  activeExportPostIds.add(postId);
  try {
    return await performPostExport(postId);
  } finally {
    activeExportPostIds.delete(postId);
  }
}
