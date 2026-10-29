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

function normalizeColor(value) {
  const color = String(value || '#4970d5').trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Màu Profile không hợp lệ.');
  return color.toLowerCase();
}

function normalizeWorkflowMode(value) {
  const mode = String(value || 'manual').trim().toLowerCase();
  if (!['manual', 'auto'].includes(mode)) throw new Error('Chế độ Profile không hợp lệ.');
  return mode;
}

function normalizeLogo(value) {
  if (!value) return null;
  const logo = String(value);
  const match = logo.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) throw new Error('Logo phải là file PNG, JPEG hoặc WebP.');
  if (Buffer.byteLength(match[2], 'base64') > 3 * 1024 * 1024) throw new Error('Logo không được vượt quá 3 MB.');
  return { data: logo, mime: `image/${match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()}` };
}

export function updateProfile(id, data) {
  const current = getProfileById(id);
  if (!current) throw new Error('Profile không tồn tại.');
  const merged = { ...current, ...data };
  const facebookPageId = normalizeFacebookPageTarget(merged.facebook_page_id);
  const color = normalizeColor(merged.color);
  const workflowMode = normalizeWorkflowMode(merged.workflow_mode);
  const retainRemovedPosts = merged.retain_removed_posts !== false && Number(merged.retain_removed_posts) !== 0;
  const logo = normalizeLogo(merged.logo_data);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE profiles 
    SET name = ?, type = ?, brand = ?, language = ?, timezone = ?, 
        folder_id_rules = ?, folder_id_topics = ?, folder_id_materials = ?, folder_id_output = ?, sheet_id_topics = ?,
        page_name = ?, facebook_page_id = ?, color = ?, workflow_mode = ?, retain_removed_posts = ?, logo_data = ?, logo_mime = ?, time = ?, active = ?, updated_at = ?
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
    color,
    workflowMode,
    retainRemovedPosts ? 1 : 0,
    logo?.data || null,
    logo?.mime || null,
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
  const color = normalizeColor(data.color);
  const workflowMode = normalizeWorkflowMode(data.workflow_mode);
  const retainRemovedPosts = data.retain_removed_posts !== false && Number(data.retain_removed_posts) !== 0;
  const logo = normalizeLogo(data.logo_data);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO profiles (id, name, type, brand, language, timezone, folder_id_rules, folder_id_topics, folder_id_materials, folder_id_output, sheet_id_topics, page_name, facebook_page_id, color, workflow_mode, retain_removed_posts, logo_data, logo_mime, time, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    color,
    workflowMode,
    retainRemovedPosts ? 1 : 0,
    logo?.data || null,
    logo?.mime || null,
    data.time || '09:00',
    data.active ? 1 : 0,
    now,
    now
  );
  return getProfileById(id);
}

export function deleteProfile(id, actorId = 'u_admin') {
  const profile = getProfileById(id);
  if (!profile) throw new Error('Content Profile không tồn tại.');

  db.exec('BEGIN IMMEDIATE');
  try {
    // `operations` predates the foreign-key schema, so remove its rows explicitly.
    db.prepare(`DELETE FROM operations WHERE post_id IN (SELECT id FROM posts WHERE profile_id = ?)`)
      .run(id);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    db.prepare(`
      INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, 'PROFILE_DELETED', 'profile', ?, ?, ?)
    `).run(
      `audit_${crypto.randomUUID().slice(0, 12)}`,
      actorId,
      id,
      JSON.stringify({ name: profile.name, type: profile.type }),
      new Date().toISOString()
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { success: true, id };
}
