import { getValidAccessToken } from './oauth.js';
import { db } from '../db.js';
import { sha256 } from '../crypto.js';

/**
 * Sync topics from Google Sheet (tab TOPICS) into SQLite database
 */
export async function syncTopicsFromSheet(profileId, spreadsheetId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive/Sheets.');

  const range = 'TOPICS!A1:Z500';
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
  if (rows.length < 2) {
    return { count: 0, imported: 0, updated: 0, skipped: 0, message: 'Sheet không có dữ liệu hàng.' };
  }

  // Map header indexes
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const colIndex = name => headers.indexOf(name);

  const idxTopicId = colIndex('topic_id') !== -1 ? colIndex('topic_id') : colIndex('id');
  const idxDate = colIndex('content_date') !== -1 ? colIndex('content_date') : colIndex('date');
  const idxTitle = colIndex('topic_title') !== -1 ? colIndex('topic_title') : colIndex('topic');
  const idxType = colIndex('content_type') !== -1 ? colIndex('content_type') : colIndex('type');
  const idxAudience = colIndex('audience');
  const idxKeyMsg = colIndex('key_message') !== -1 ? colIndex('key_message') : colIndex('message');
  const idxFacts = colIndex('facts');
  const idxFactSrc = colIndex('fact_source_ids');
  const idxAssetFolder = colIndex('asset_folder_id');
  const idxPublishTime = colIndex('publish_time') !== -1 ? colIndex('publish_time') : colIndex('time');
  const idxLang = colIndex('language');
  const idxCta = colIndex('cta');
  const idxReqText = colIndex('required_text');
  const idxStatus = colIndex('status');

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const topicId = (idxTopicId !== -1 ? row[idxTopicId] : null)?.trim() || `row_${i}`;
    const title = (idxTitle !== -1 ? row[idxTitle] : null)?.trim();
    if (!title) {
      skipped++;
      continue;
    }

    const contentDate = (idxDate !== -1 ? row[idxDate] : null)?.trim() || '';
    const contentType = (idxType !== -1 ? row[idxType] : '')?.trim();
    const audience = (idxAudience !== -1 ? row[idxAudience] : '')?.trim();
    const keyMessage = (idxKeyMsg !== -1 ? row[idxKeyMsg] : '')?.trim();
    const facts = (idxFacts !== -1 ? row[idxFacts] : '')?.trim();
    const factSourceIds = (idxFactSrc !== -1 ? row[idxFactSrc] : '')?.trim();
    const assetFolderId = (idxAssetFolder !== -1 ? row[idxAssetFolder] : '')?.trim();
    const publishTime = (idxPublishTime !== -1 ? row[idxPublishTime] : '')?.trim() || '';
    const language = (idxLang !== -1 ? row[idxLang] : '')?.trim() || 'vi';
    const cta = (idxCta !== -1 ? row[idxCta] : '')?.trim();
    const requiredText = (idxReqText !== -1 ? row[idxReqText] : '')?.trim();
    const status = ((idxStatus !== -1 ? row[idxStatus] : '')?.trim() || 'READY').toUpperCase();

    const rowData = {
      profileId,
      topicId,
      contentDate,
      title,
      contentType,
      audience,
      keyMessage,
      facts,
      factSourceIds,
      assetFolderId,
      publishTime,
      language,
      cta,
      requiredText,
      status
    };

    const hash = sha256(rowData);

    // Check existing
    const existing = db.prepare('SELECT * FROM topics WHERE profile_id = ? AND topic_id = ?').get(profileId, topicId);

    if (existing) {
      if (existing.source_hash !== hash) {
        db.prepare(`
          UPDATE topics 
          SET content_date = ?, topic_title = ?, content_type = ?, audience = ?, key_message = ?, facts = ?, fact_source_ids = ?, asset_folder_id = ?, publish_time = ?, language = ?, cta = ?, required_text = ?, status = ?, source_hash = ?, source_revision = source_revision + 1, imported_at = ?
          WHERE id = ?
        `).run(contentDate, title, contentType, audience, keyMessage, facts, factSourceIds, assetFolderId, publishTime, language, cta, requiredText, status, hash, now, existing.id);
        updated++;
      } else {
        skipped++;
      }
    } else {
      const id = `top_${profileId}_${topicId}`;
      db.prepare(`
        INSERT INTO topics (id, profile_id, topic_id, content_date, topic_title, content_type, audience, key_message, facts, fact_source_ids, asset_folder_id, publish_time, language, cta, required_text, status, source_hash, source_revision, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(id, profileId, topicId, contentDate, title, contentType, audience, keyMessage, facts, factSourceIds, assetFolderId, publishTime, language, cta, requiredText, status, hash, now);
      imported++;
    }
  }

  return { total: rows.length - 1, imported, updated, skipped };
}
