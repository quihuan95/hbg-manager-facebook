import crypto from 'node:crypto';
import { db } from '../db.js';
import { sha256 } from '../crypto.js';
import { getLatestPublishedRule } from './rule.js';
import { getProfileById } from './profile.js';
import { storeMediaValue } from '../media.js';

export function getAllPosts(filterStatus = null, filterProfile = null) {
  let query = `
    SELECT p.*, prof.name as profile_name, prof.type as profile_type, prof.page_name, prof.facebook_page_id,
           r.topic_title, r.caption, r.headline, r.cta, r.image_data, r.image_mime, r.revision_number, r.revision_hash, r.validation_findings_json,
           app.approved_at, app.approver_id,
           exp.status as export_status, exp.drive_folder_id,
           mu.uploaded_at as manually_uploaded_at, mu.post_url as manual_post_url, mu.target_page as manual_target_page
    FROM posts p
    JOIN profiles prof ON p.profile_id = prof.id
    LEFT JOIN post_revisions r ON p.current_revision_id = r.id
    LEFT JOIN approvals app ON p.id = app.post_id AND r.id = app.revision_id
    LEFT JOIN exports exp ON p.id = exp.post_id AND r.id = exp.revision_id
    LEFT JOIN manual_uploads mu ON p.id = mu.post_id AND r.id = mu.revision_id
    WHERE 1=1
  `;
  const params = [];
  if (filterStatus) {
    query += ' AND p.status = ?';
    params.push(filterStatus);
  }
  if (filterProfile) {
    query += ' AND p.profile_id = ?';
    params.push(filterProfile);
  }
  query += ' ORDER BY p.content_date DESC, p.created_at DESC';

  return db.prepare(query).all(...params);
}

export function getPostById(postId) {
  return db.prepare(`
    SELECT p.*, prof.name as profile_name, prof.type as profile_type, prof.folder_id_output, prof.page_name, prof.facebook_page_id, prof.logo_data,
           r.id as revision_id, r.topic_title, r.caption, r.headline, r.cta, r.image_brief, r.image_data, r.image_mime, r.image_set_json, r.revision_number, r.revision_hash, r.rule_version_id, r.rule_hash, r.topic_snapshot_json, r.validation_findings_json,
           app.approved_at, app.approver_id,
           exp.status as export_status, exp.drive_folder_id, exp.drive_caption_file_id, exp.drive_image_file_id, exp.drive_manifest_file_id, exp.drive_review_file_id,
           mu.uploaded_at as manually_uploaded_at, mu.post_url as manual_post_url, mu.note as manual_note, mu.target_page as manual_target_page,
           (SELECT t.image_rule FROM topics t WHERE t.profile_id = p.profile_id AND t.topic_id = p.topic_id LIMIT 1) as sheet_image_rule,
           (SELECT t.image_frame_drive_link FROM topics t WHERE t.profile_id = p.profile_id AND t.topic_id = p.topic_id LIMIT 1) as image_frame_drive_link,
           (SELECT t.source_image_drive_link FROM topics t WHERE t.profile_id = p.profile_id AND t.topic_id = p.topic_id LIMIT 1) as source_image_drive_link,
           (SELECT ae.details_json FROM audit_events ae WHERE ae.entity_id = p.id AND ae.action = 'REQUEST_CHANGES' ORDER BY ae.created_at DESC LIMIT 1) as change_request_details_json,
           (SELECT ae.actor_id FROM audit_events ae WHERE ae.entity_id = p.id AND ae.action = 'REQUEST_CHANGES' ORDER BY ae.created_at DESC LIMIT 1) as change_requested_by,
           (SELECT ae.created_at FROM audit_events ae WHERE ae.entity_id = p.id AND ae.action = 'REQUEST_CHANGES' ORDER BY ae.created_at DESC LIMIT 1) as change_requested_at
    FROM posts p
    JOIN profiles prof ON p.profile_id = prof.id
    LEFT JOIN post_revisions r ON p.current_revision_id = r.id
    LEFT JOIN approvals app ON p.id = app.post_id AND r.id = app.revision_id
    LEFT JOIN exports exp ON p.id = exp.post_id AND r.id = exp.revision_id
    LEFT JOIN manual_uploads mu ON p.id = mu.post_id AND r.id = mu.revision_id
    WHERE p.id = ?
  `).get(postId);
}

export function createPostFromTopic(profileId, topicTitle, contentDate = null, scheduledTime = '09:00', topicId = null, creationSource = 'manual') {
  const profile = getProfileById(profileId);
  if (!profile) throw new Error('Profile không tồn tại.');

  const rule = getLatestPublishedRule(profileId);
  if (!rule) throw new Error('Profile chưa có Rule version được kích hoạt.');

  const postId = `post_${crypto.randomUUID().slice(0, 10)}`;
  const revisionId = `rev_${postId}_1`;
  const now = new Date().toISOString();
  const date = contentDate || now.slice(0, 10);

  const topicSnapshot = {
    topic_id: topicId || null,
    topic_title: topicTitle,
    content_date: date,
    scheduled_time: scheduledTime
  };

  const initialFindings = [
    { rule: 'Caption có nội dung', pass: false, type: 'blocker' },
    { rule: 'Có ảnh đính kèm (upload hoặc AI)', pass: false, type: 'blocker' }
  ];

  const revisionHash = sha256({
    postId,
    revisionNumber: 1,
    topicTitle,
    caption: '',
    ruleHash: rule.hash
  });

  // Create post
  db.prepare(`
    INSERT INTO posts (id, profile_id, topic_id, content_date, scheduled_time, current_revision_id, creation_source, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
  `).run(postId, profileId, topicId, date, scheduledTime, revisionId, creationSource === 'automation' ? 'automation' : 'manual', now, now);

  // Create revision 1
  db.prepare(`
    INSERT INTO post_revisions (id, post_id, revision_number, topic_title, caption, rule_version_id, rule_hash, topic_snapshot_json, validation_findings_json, revision_hash, created_at)
    VALUES (?, ?, 1, ?, '', ?, ?, ?, ?, ?, ?)
  `).run(revisionId, postId, topicTitle, rule.id, rule.hash, JSON.stringify(topicSnapshot), JSON.stringify(initialFindings), revisionHash, now);

  return getPostById(postId);
}

export function createNewRevision(postId, updates, expectedRevisionId = null) {
  const currentPost = getPostById(postId);
  if (!currentPost) throw new Error('Không tìm thấy bài viết.');

  // Optimistic locking check
  if (expectedRevisionId && currentPost.current_revision_id !== expectedRevisionId) {
    throw new Error('REVISION_CONFLICT: Bài viết đã được chỉnh sửa bởi phiên làm việc khác. Vui lòng tải lại trang.');
  }

  const currentRev = db.prepare('SELECT * FROM post_revisions WHERE id = ?').get(currentPost.current_revision_id);
  const nextRevNum = (currentRev?.revision_number || 1) + 1;
  const nextRevId = `rev_${postId}_${nextRevNum}`;
  const now = new Date().toISOString();

  const caption = updates.caption !== undefined ? updates.caption : (currentRev?.caption || '');
  const headline = updates.headline !== undefined ? updates.headline : (currentRev?.headline || '');
  const cta = updates.cta !== undefined ? updates.cta : (currentRev?.cta || '');
  const imageBrief = updates.imageBrief !== undefined ? updates.imageBrief : (currentRev?.image_brief || '');
  const rawImageData = updates.imageData !== undefined ? updates.imageData : (currentRev?.image_data || null);
  const imageData = storeMediaValue(rawImageData, 'images');
  const imageMime = updates.imageMime !== undefined ? updates.imageMime : (currentRev?.image_mime || null);
  let imageSet;
  if (updates.imageSet !== undefined) {
    imageSet = (updates.imageSet || []).map(item => ({
      ...item,
      data: storeMediaValue(item.data, 'images')
    })).filter(item => item.data);
  } else if (updates.imageData !== undefined) {
    imageSet = imageData ? [{ data: imageData, mime: imageMime || 'image/png', brief: imageBrief }] : [];
  } else {
    try { imageSet = JSON.parse(currentRev?.image_set_json || '[]'); } catch { imageSet = []; }
    if (!imageSet.length && imageData) imageSet = [{ data: imageData, mime: imageMime || 'image/png', brief: imageBrief }];
  }
  const imageSetJson = imageSet.length ? JSON.stringify(imageSet) : null;

  // Re-evaluate validation findings
  const findings = [
    { rule: 'Caption có nội dung', pass: !!caption.trim(), type: 'blocker' },
    { rule: 'Có ảnh đính kèm (upload hoặc AI)', pass: !!imageData, type: 'blocker' }
  ];

  const revisionHash = sha256({
    postId,
    revisionNumber: nextRevNum,
    caption,
    headline,
    imageData: imageSet.length ? imageSet.map(item => sha256(item.data)) : null,
    ruleHash: currentRev?.rule_hash
  });

  db.prepare(`
    INSERT INTO post_revisions (id, post_id, revision_number, parent_revision_id, topic_title, caption, headline, cta, image_brief, image_data, image_mime, image_set_json, rule_version_id, rule_hash, topic_snapshot_json, validation_findings_json, revision_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nextRevId,
    postId,
    nextRevNum,
    currentPost.current_revision_id,
    currentPost.topic_title,
    caption,
    headline,
    cta,
    imageBrief,
    imageData,
    imageMime,
    imageSetJson,
    currentRev?.rule_version_id,
    currentRev?.rule_hash,
    currentRev?.topic_snapshot_json,
    JSON.stringify(findings),
    revisionHash,
    now
  );

  // Updating post status back to NEEDS_REVIEW or DRAFT (invalidating prior approvals)
  db.prepare(`
    UPDATE posts 
    SET current_revision_id = ?, status = 'NEEDS_REVIEW', updated_at = ?
    WHERE id = ?
  `).run(nextRevId, now, postId);

  return getPostById(postId);
}

export function updatePostStatus(postId, newStatus) {
  db.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?')
    .run(newStatus, new Date().toISOString(), postId);
  return getPostById(postId);
}

export function deletePost(postId, actorId = 'u_admin') {
  const post = getPostById(postId);
  if (!post) throw new Error('Không tìm thấy bài viết.');

  db.exec('BEGIN IMMEDIATE');
  try {
    // operations does not have a foreign key in the initial schema.
    db.prepare('DELETE FROM operations WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
    db.prepare(`
      INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, 'POST_DELETED', 'post', ?, ?, ?)
    `).run(
      `audit_${crypto.randomUUID().slice(0, 12)}`,
      actorId,
      postId,
      JSON.stringify({ topicTitle: post.topic_title, profileId: post.profile_id, previousStatus: post.status }),
      new Date().toISOString()
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { success: true, id: postId };
}
