import crypto from 'node:crypto';
import { db } from '../db.js';
import { getPostById, updatePostStatus } from '../models/post.js';

export function approvePost(postId, approverId = 'u_admin', checklist = {}) {
  const post = getPostById(postId);
  if (!post) throw new Error('Không tìm thấy bài viết.');

  const rev = db.prepare('SELECT * FROM post_revisions WHERE id = ?').get(post.current_revision_id);
  if (!rev) throw new Error('Không tìm thấy revision hiện tại.');

  // Check blockers
  if (!rev.caption || !rev.caption.trim()) {
    throw new Error('BLOCKER: Caption không được để trống khi duyệt.');
  }
  if (!rev.image_data) {
    throw new Error('BLOCKER: Bài viết phải có hình ảnh hoàn chỉnh trước khi duyệt.');
  }

  const approvalId = `app_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();

  // Delete previous approval for this revision if exists
  db.prepare('DELETE FROM approvals WHERE post_id = ? AND revision_id = ?').run(postId, rev.id);

  db.prepare(`
    INSERT INTO approvals (id, post_id, revision_id, revision_hash, approver_id, approved_at, checklist_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(approvalId, postId, rev.id, rev.revision_hash, approverId, now, JSON.stringify(checklist));

  updatePostStatus(postId, 'APPROVED');

  // Add audit log
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, revision_id, details_json, created_at)
    VALUES (?, ?, 'APPROVE_POST', 'post', ?, ?, ?, ?)
  `).run(`audit_${Date.now()}`, approverId, postId, rev.id, JSON.stringify({ revision_number: rev.revision_number }), now);

  return getPostById(postId);
}

export function requestChanges(postId, actorId = 'u_admin', reason = '') {
  const post = getPostById(postId);
  if (!post) throw new Error('Không tìm thấy bài viết.');

  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) throw new Error('Vui lòng nhập lý do cần sửa lại bài viết.');

  updatePostStatus(postId, 'DRAFT');

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, revision_id, details_json, created_at)
    VALUES (?, ?, 'REQUEST_CHANGES', 'post', ?, ?, ?, ?)
  `).run(`audit_${Date.now()}`, actorId, postId, post.current_revision_id, JSON.stringify({ reason: normalizedReason }), now);

  return getPostById(postId);
}
