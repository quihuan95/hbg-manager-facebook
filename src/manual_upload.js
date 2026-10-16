import crypto from 'node:crypto';
import { db } from './db.js';
import { getPostById, updatePostStatus } from './models/post.js';

export function markManuallyUploaded(postId, uploaderId = 'u_admin', postUrl = '', note = '', pageTarget = '') {
  const post = getPostById(postId);
  if (!post) throw new Error('Không tìm thấy bài viết.');

  if (post.status !== 'READY_FOR_MANUAL_UPLOAD' && post.status !== 'APPROVED') {
    throw new Error('Chỉ bài viết ở trạng thái sẵn sàng (READY_FOR_MANUAL_UPLOAD / APPROVED) mới có thể đánh dấu đã đăng.');
  }

  const targetPage = String(pageTarget || post.facebook_page_id || '').trim();
  if (!targetPage) throw new Error('Profile chưa cấu hình Facebook Page ID hoặc link Page.');
  if (!/^\d+$/.test(targetPage)) {
    try {
      const targetUrl = new URL(targetPage);
      if (!/(^|\.)facebook\.com$/i.test(targetUrl.hostname) && !/(^|\.)fb\.com$/i.test(targetUrl.hostname)) throw new Error();
    } catch {
      throw new Error('Trang đích phải là Page ID dạng số hoặc link facebook.com hợp lệ.');
    }
  }

  // Validate Facebook URL if provided
  if (postUrl && postUrl.trim()) {
    try {
      const u = new URL(postUrl.trim());
      if (!u.hostname.includes('facebook.com') && !u.hostname.includes('fb.com')) {
        throw new Error('Link bài viết phải thuộc domain facebook.com.');
      }
    } catch (e) {
      throw new Error(e.message || 'URL bài viết không hợp lệ.');
    }
  }

  const uploadId = `mu_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();

  // Delete previous record if exists
  db.prepare('DELETE FROM manual_uploads WHERE post_id = ? AND revision_id = ?').run(postId, post.current_revision_id);

  db.prepare(`
    INSERT INTO manual_uploads (id, post_id, revision_id, uploader_id, uploaded_at, post_url, note, target_page)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uploadId, postId, post.current_revision_id, uploaderId, now, postUrl.trim() || null, note.trim() || null, targetPage);

  updatePostStatus(postId, 'MANUALLY_UPLOADED');

  // Audit event
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, revision_id, details_json, created_at)
    VALUES (?, ?, 'MARK_MANUALLY_UPLOADED', 'post', ?, ?, ?, ?)
  `).run(`audit_${crypto.randomUUID().slice(0, 12)}`, uploaderId, postId, post.current_revision_id, JSON.stringify({ post_url: postUrl, note, target_page: targetPage }), now);

  return getPostById(postId);
}

export function markManyManuallyUploaded(postIds, uploaderId = 'u_admin', note = '') {
  if (!Array.isArray(postIds) || postIds.length === 0) {
    throw new Error('Hãy chọn ít nhất một bài để đăng.');
  }

  const uniquePostIds = [...new Set(postIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  if (uniquePostIds.length === 0) throw new Error('Danh sách bài đăng không hợp lệ.');
  if (uniquePostIds.length > 100) throw new Error('Chỉ có thể đăng tối đa 100 bài trong một lần.');

  const published = [];
  const skipped = [];
  for (const postId of uniquePostIds) {
    const post = getPostById(postId);
    if (!post) {
      skipped.push({ id: postId, reason: 'Không tìm thấy bài viết.' });
      continue;
    }
    if (!['READY_FOR_MANUAL_UPLOAD', 'APPROVED'].includes(post.status)) {
      skipped.push({ id: postId, reason: `Trạng thái ${post.status} chưa sẵn sàng đăng.` });
      continue;
    }
    try {
      markManuallyUploaded(postId, uploaderId, '', note);
      published.push(postId);
    } catch (error) {
      skipped.push({ id: postId, reason: error.message });
    }
  }

  return { success: published.length > 0, published, skipped };
}
