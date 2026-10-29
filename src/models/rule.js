import { db } from '../db.js';
import { sha256 } from '../crypto.js';

export function getLatestPublishedRule(profileId) {
  return db.prepare(`
    SELECT * FROM rule_versions 
    WHERE profile_id = ? AND status = 'published' 
    ORDER BY version DESC LIMIT 1
  `).get(profileId);
}

export function getAllRuleVersions(profileId) {
  return db.prepare(`
    SELECT * FROM rule_versions 
    WHERE profile_id = ? 
    ORDER BY version DESC
  `).all(profileId);
}

export function createRuleVersion(profileId, contentMarkdown, publishConfigJson = null, createdBy = 'u_admin') {
  const latest = db.prepare('SELECT MAX(version) as max_v FROM rule_versions WHERE profile_id = ?').get(profileId);
  const nextVersion = (latest?.max_v || 0) + 1;
  const hash = sha256({ profileId, version: nextVersion, contentMarkdown, publishConfigJson });
  const id = `rv_${profileId}_${nextVersion}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO rule_versions (id, profile_id, version, content_markdown, publish_config_json, hash, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?)
  `).run(id, profileId, nextVersion, contentMarkdown, publishConfigJson ? JSON.stringify(publishConfigJson) : null, hash, createdBy, now);

  return db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id);
}

export function deleteRuleVersions(profileId, actorId = 'u_admin') {
  const profile = db.prepare('SELECT id, name FROM profiles WHERE id = ?').get(profileId);
  if (!profile) throw new Error('Content Profile không tồn tại.');
  const count = db.prepare('SELECT COUNT(*) AS count FROM rule_versions WHERE profile_id = ?').get(profileId).count;
  if (!count) throw new Error('Profile chưa có Rule để xóa.');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM rule_versions WHERE profile_id = ?').run(profileId);
    db.prepare(`
      INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, 'PROFILE_RULES_DELETED', 'profile_rules', ?, ?, ?)
    `).run(
      `audit_${crypto.randomUUID().slice(0, 12)}`,
      actorId,
      profileId,
      JSON.stringify({ profileName: profile.name, deletedVersions: count }),
      new Date().toISOString()
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { success: true, profileId, deletedVersions: count };
}
