import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const mediaRoot = path.join(path.dirname(config.dbPath), 'media');

const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp'
};

function dataUrlParts(value) {
  const match = String(value || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/is);
  if (!match) return null;
  return { mime: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), buffer: Buffer.from(match[2], 'base64') };
}

export function storeMediaValue(value, kind = 'images') {
  if (!value) return null;
  const raw = String(value);
  if (raw.startsWith('/media/')) return raw;
  const parsed = dataUrlParts(raw);
  if (!parsed) return raw;

  const safeKind = kind === 'logos' ? 'logos' : 'images';
  const extension = MIME_EXTENSIONS[parsed.mime] || 'png';
  const filename = `${crypto.createHash('sha256').update(parsed.buffer).digest('hex')}.${extension}`;
  const directory = path.join(mediaRoot, safeKind);
  const target = path.join(directory, filename);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, parsed.buffer);
  return `/media/${safeKind}/${filename}`;
}

export function resolveMediaPath(urlPath) {
  const match = String(urlPath || '').match(/^\/media\/(images|logos)\/([a-f0-9]{64}\.(?:png|jpg|webp))$/i);
  if (!match) return null;
  const target = path.resolve(mediaRoot, match[1].toLowerCase(), match[2].toLowerCase());
  const root = `${path.resolve(mediaRoot)}${path.sep}`;
  return target.startsWith(root) ? target : null;
}

export function readMediaBuffer(value) {
  if (!value) return null;
  const parsed = dataUrlParts(value);
  if (parsed) return parsed.buffer;
  const mediaPath = resolveMediaPath(value);
  if (mediaPath && fs.existsSync(mediaPath)) return fs.readFileSync(mediaPath);
  return null;
}

export function mediaMime(value, fallback = 'image/png') {
  const parsed = dataUrlParts(value);
  if (parsed) return parsed.mime;
  const extension = path.extname(String(value || '')).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.png') return 'image/png';
  return fallback;
}

export function migrateBase64Media(db) {
  const revisions = db.prepare("SELECT id, image_data FROM post_revisions WHERE image_data LIKE 'data:image/%;base64,%'").all();
  const profiles = db.prepare("SELECT id, logo_data FROM profiles WHERE logo_data LIKE 'data:image/%;base64,%'").all();
  if (!revisions.length && !profiles.length) return { revisions: 0, profiles: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    const updateRevision = db.prepare('UPDATE post_revisions SET image_data = ? WHERE id = ?');
    for (const row of revisions) updateRevision.run(storeMediaValue(row.image_data, 'images'), row.id);
    const updateProfile = db.prepare('UPDATE profiles SET logo_data = ? WHERE id = ?');
    for (const row of profiles) updateProfile.run(storeMediaValue(row.logo_data, 'logos'), row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  return { revisions: revisions.length, profiles: profiles.length };
}
