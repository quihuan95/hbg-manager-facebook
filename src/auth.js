import crypto from 'node:crypto';
import { db } from './db.js';

export function createSession(userId, hours = 72) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const createdAt = new Date().toISOString();

  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, expiresAt, createdAt);

  return { token, expiresAt };
}

export function validateSession(token) {
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.email, u.name, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(token);

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return {
    id: session.id,
    email: session.email,
    name: session.name,
    role: session.role
  };
}

export function getDefaultUser() {
  return db.prepare('SELECT id, email, name, role FROM users LIMIT 1').get();
}
