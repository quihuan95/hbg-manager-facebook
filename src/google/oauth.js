import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { encryptToken, decryptToken } from '../crypto.js';

export function getGoogleAuthUrl(userId = 'u_admin') {
  const state = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const createdAt = new Date().toISOString();

  db.prepare('INSERT INTO oauth_states (state, user_id, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(state, userId, config.google.redirectUri, expiresAt, createdAt);

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: config.google.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleGoogleCallback(code, state) {
  // Validate state
  const stateRecord = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (!stateRecord) {
    throw new Error('State không hợp lệ hoặc đã hết hạn (CSRF Protection).');
  }
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  if (new Date(stateRecord.expires_at) < new Date()) {
    throw new Error('OAuth State đã hết hạn. Vui lòng thử lại.');
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(err.error_description || 'Không thể đổi token từ Google.');
  }

  const tokenData = await tokenRes.json();
  const { access_token, refresh_token, expires_in, scope } = tokenData;

  // Get user info
  let email = 'unknown@google.com';
  let name = 'Google User';
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (userRes.ok) {
      const u = await userRes.json();
      email = u.email || email;
      name = u.name || name;
    }
  } catch (err) {
    console.error('Failed to fetch user info:', err);
  }

  // Check if existing connection exists to preserve refresh token if Google didn't return a new one
  const existing = db.prepare("SELECT * FROM connections WHERE provider = 'google'").get();
  let finalRefreshToken = refresh_token;
  if (!finalRefreshToken && existing) {
    try {
      const decrypted = JSON.parse(decryptToken(existing.encrypted_tokens));
      finalRefreshToken = decrypted.refresh_token;
    } catch {}
  }

  const tokenPayload = JSON.stringify({
    access_token,
    refresh_token: finalRefreshToken,
    expires_at: Date.now() + (expires_in || 3600) * 1000
  });

  const encrypted = encryptToken(tokenPayload);
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE connections 
      SET encrypted_tokens = ?, scopes = ?, account_email = ?, account_name = ?, status = 'active', last_health_check = ?, updated_at = ?
      WHERE id = ?
    `).run(encrypted, scope || config.google.scopes.join(' '), email, name, now, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO connections (id, provider, user_id, encrypted_tokens, scopes, account_email, account_name, status, last_health_check, created_at, updated_at)
      VALUES (?, 'google', ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(`conn_${crypto.randomUUID().slice(0, 8)}`, stateRecord.user_id || 'u_admin', encrypted, scope || config.google.scopes.join(' '), email, name, now, now, now);
  }

  return { email, name };
}

export async function getValidAccessToken() {
  const conn = db.prepare("SELECT * FROM connections WHERE provider = 'google' AND status = 'active'").get();
  if (!conn) {
    return null;
  }

  let tokens;
  try {
    tokens = JSON.parse(decryptToken(conn.encrypted_tokens));
  } catch {
    db.prepare("UPDATE connections SET status = 'needs_reconnect' WHERE id = ?").run(conn.id);
    return null;
  }

  // If token is still valid for > 5 minutes
  if (tokens.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 5 * 60 * 1000) {
    return tokens.access_token;
  }

  // Refresh token
  if (!tokens.refresh_token) {
    db.prepare("UPDATE connections SET status = 'needs_reconnect' WHERE id = ?").run(conn.id);
    return null;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      })
    });

    if (!res.ok) {
      db.prepare("UPDATE connections SET status = 'needs_reconnect' WHERE id = ?").run(conn.id);
      return null;
    }

    const data = await res.json();
    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
    if (data.refresh_token) tokens.refresh_token = data.refresh_token;

    const encrypted = encryptToken(JSON.stringify(tokens));
    db.prepare("UPDATE connections SET encrypted_tokens = ?, updated_at = ? WHERE id = ?")
      .run(encrypted, new Date().toISOString(), conn.id);

    return tokens.access_token;
  } catch (err) {
    console.error('Refresh token error:', err);
    return null;
  }
}

export function getConnectionStatus() {
  const conn = db.prepare("SELECT id, provider, account_email, account_name, status, last_health_check, updated_at FROM connections WHERE provider = 'google'").get();
  return conn || { status: 'not_connected' };
}
