import { db } from '../db.js';

export function getAllProfiles() {
  return db.prepare('SELECT * FROM profiles ORDER BY name ASC').all();
}

export function getProfileById(id) {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
}

function normalizeFacebookPageTarget(value) {
  const target = String(value || '').trim();
  if (!target || /^\d+$/.test(target)) return target;
  try {
    const url = new URL(target);
    if (!/(^|\.)facebook\.com$/i.test(url.hostname) && !/(^|\.)fb\.com$/i.test(url.hostname)) throw new Error();
    return url.toString();
  } catch {
    throw new Error('Facebook Page phải là Page ID dạng số hoặc link facebook.com hợp lệ.');
  }
}

export function updateProfile(id, data) {
  const current = getProfileById(id);
  if (!current) throw new Error('Profile không tồn tại.');
  const merged = { ...current, ...data };
  const facebookPageId = normalizeFacebookPageTarget(merged.facebook_page_id);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE profiles 
    SET name = ?, type = ?, brand = ?, language = ?, timezone = ?, 
        folder_id_rules = ?, folder_id_topics = ?, folder_id_materials = ?, folder_id_output = ?, sheet_id_topics = ?,
        page_name = ?, facebook_page_id = ?, time = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.name,
    merged.type,
    merged.brand || null,
    merged.language || 'vi',
    merged.timezone || 'Asia/Ho_Chi_Minh',
    merged.folder_id_rules || null,
    merged.folder_id_topics || null,
    merged.folder_id_materials || null,
    merged.folder_id_output || null,
    merged.sheet_id_topics || null,
    merged.page_name || null,
    facebookPageId || null,
    merged.time || '09:00',
    merged.active ? 1 : 0,
    now,
    id
  );
  return getProfileById(id);
}

export function createProfile(data) {
  const id = data.id || `prof_${Date.now()}`;
  const facebookPageId = normalizeFacebookPageTarget(data.facebook_page_id);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO profiles (id, name, type, brand, language, timezone, folder_id_rules, folder_id_topics, folder_id_materials, folder_id_output, sheet_id_topics, page_name, facebook_page_id, time, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.type,
    data.brand || null,
    data.language || 'vi',
    data.timezone || 'Asia/Ho_Chi_Minh',
    data.folder_id_rules || null,
    data.folder_id_topics || null,
    data.folder_id_materials || null,
    data.folder_id_output || null,
    data.sheet_id_topics || null,
    data.page_name || null,
    facebookPageId || null,
    data.time || '09:00',
    data.active ? 1 : 0,
    now,
    now
  );
  return getProfileById(id);
}
