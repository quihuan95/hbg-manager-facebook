import { getValidAccessToken } from './oauth.js';
import { db } from '../db.js';
import { sha256 } from '../crypto.js';
import crypto from 'node:crypto';

function normalizeContentDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!match) throw new Error(`Ngày "${raw}" không hợp lệ. Dùng YYYY-MM-DD hoặc DD/MM/YYYY.`);
  const [, day, month, year] = match;
  const normalized = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month) || parsed.getUTCDate() !== Number(day)) {
    throw new Error(`Ngày "${raw}" không tồn tại.`);
  }
  return normalized;
}

function normalizePublishTime(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`Giờ "${raw}" không hợp lệ. Dùng HH:mm.`);
  }
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * Sync topics from Google Sheet (tab TOPICS) into SQLite database
 */
export async function syncTopicsFromSheet(profileId, spreadsheetId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive/Sheets.');

  const range = 'TOPICS!A1:E500';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Không thể đọc Google Sheet (${spreadsheetId}): ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const rows = data.values || [];
  if (rows.length === 0) throw new Error('Tab TOPICS chưa có hàng tiêu đề.');

  // Map header indexes
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const colIndex = name => headers.indexOf(name);

  const requiredHeaders = ['topic_id', 'content_date', 'publish_time', 'topic_title'];
  const missingHeaders = requiredHeaders.filter(name => colIndex(name) === -1);
  if (missingHeaders.length) {
    throw new Error(`Tab TOPICS thiếu cột bắt buộc: ${missingHeaders.join(', ')}.`);
  }
  const idxTopicId = colIndex('topic_id');
  const idxDate = colIndex('content_date');
  const idxPublishTime = colIndex('publish_time');
  const idxTitle = colIndex('topic_title');
  const idxImageRule = colIndex('image_rule');

  const seenTopicIds = new Set();
  for (let i = 1; i < rows.length; i++) {
    const values = requiredHeaders.map(name => String(rows[i][colIndex(name)] || '').trim());
    if (values.every(value => !value)) continue;
    const missingValues = requiredHeaders.filter((name, index) => !values[index]);
    if (missingValues.length) throw new Error(`Dòng ${i + 1} thiếu giá trị: ${missingValues.join(', ')}.`);
    try {
      normalizeContentDate(rows[i][idxDate]);
      normalizePublishTime(rows[i][idxPublishTime]);
    } catch (error) {
      throw new Error(`Dòng ${i + 1}: ${error.message}`);
    }
    const topicId = String(rows[i][idxTopicId]).trim();
    if (seenTopicIds.has(topicId)) throw new Error(`Dòng ${i + 1} bị trùng topic_id: ${topicId}.`);
    seenTopicIds.add(topicId);
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let removed = 0;
  let removedPosts = 0;
  let archivedPosts = 0;
  const now = new Date().toISOString();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const values = requiredHeaders.map(name => String(row[colIndex(name)] || '').trim());
    if (values.every(value => !value)) {
      skipped++;
      continue;
    }
    const topicId = String(row[idxTopicId]).trim();
    const contentDate = normalizeContentDate(row[idxDate]);
    const publishTime = normalizePublishTime(row[idxPublishTime]);
    const title = String(row[idxTitle]).trim();
    const imageRule = idxImageRule === -1 ? '' : String(row[idxImageRule] || '').trim();

    const rowData = {
      profileId,
      topicId,
      contentDate,
      title,
      publishTime,
      imageRule
    };

    const hash = sha256(rowData);

    // Check existing
    const existing = db.prepare('SELECT * FROM topics WHERE profile_id = ? AND topic_id = ?').get(profileId, topicId);

    if (existing) {
      if (existing.source_hash !== hash) {
        db.prepare(`
          UPDATE topics 
          SET content_date = ?, topic_title = ?, publish_time = ?, image_rule = ?,
              content_type = NULL, audience = NULL, key_message = NULL, facts = NULL,
              fact_source_ids = NULL, asset_folder_id = NULL, language = 'vi', cta = NULL, required_text = NULL,
              status = 'READY', source_hash = ?, source_revision = source_revision + 1, imported_at = ?
          WHERE id = ?
        `).run(contentDate, title, publishTime, imageRule || null, hash, now, existing.id);
        updated++;
      } else {
        skipped++;
      }
    } else {
      const id = `top_${profileId}_${topicId}`;
      db.prepare(`
        INSERT INTO topics (id, profile_id, topic_id, content_date, topic_title, publish_time, image_rule, language, status, source_hash, source_revision, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'vi', 'READY', ?, 1, ?)
      `).run(id, profileId, topicId, contentDate, title, publishTime, imageRule || null, hash, now);
      imported++;
    }
  }

  const syncedIds = [...seenTopicIds];
  const missingClause = syncedIds.length
    ? `topic_id NOT IN (${syncedIds.map(() => '?').join(', ')})`
    : '1 = 1';
  const missingParams = [profileId, ...syncedIds];

  db.exec('BEGIN IMMEDIATE');
  try {
    const profile = db.prepare('SELECT retain_removed_posts FROM profiles WHERE id = ?').get(profileId);
    const removedTopicIds = db.prepare(`SELECT topic_id FROM topics WHERE profile_id = ? AND ${missingClause}`)
      .all(...missingParams).map(topic => topic.topic_id);
    const postIds = removedTopicIds.length
      ? db.prepare(`SELECT id FROM posts WHERE profile_id = ? AND topic_id IN (${removedTopicIds.map(() => '?').join(', ')})`)
        .all(profileId, ...removedTopicIds).map(post => post.id)
      : [];

    if (postIds.length) {
      const postPlaceholders = postIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM operations WHERE post_id IN (${postPlaceholders})`).run(...postIds);
      if (profile?.retain_removed_posts) {
        archivedPosts = db.prepare(`UPDATE posts SET status = 'ARCHIVED', updated_at = ? WHERE id IN (${postPlaceholders})`)
          .run(now, ...postIds).changes;
      } else {
        removedPosts = db.prepare(`DELETE FROM posts WHERE id IN (${postPlaceholders})`).run(...postIds).changes;
      }
    }

    removed = db.prepare(`DELETE FROM topics WHERE profile_id = ? AND ${missingClause}`)
      .run(...missingParams).changes;

    if (removed || removedPosts || archivedPosts) {
      db.prepare(`
        INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
        VALUES (?, 'u_admin', 'SHEET_RECONCILED', 'profile', ?, ?, ?)
      `).run(
        `audit_${crypto.randomUUID().slice(0, 12)}`,
        profileId,
        JSON.stringify({ removedTopics: removed, removedPosts, archivedPosts }),
        now
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { total: seenTopicIds.size, imported, updated, skipped, removed, removedPosts, archivedPosts };
}
