import crypto from 'node:crypto';
import { config } from './config.js';

function getKeyBuffer() {
  const hex = config.tokenEncryptionKey;
  if (!hex || hex.length < 64) {
    // If not configured with full 64 hex, hash authSecret or derive 32 bytes safely
    return crypto.createHash('sha256').update(hex || config.authSecret).digest();
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

/**
 * Encrypts sensitive text using AES-256-GCM
 * Output format: iv:authTag:ciphertext (base64)
 */
export function encryptToken(text) {
  if (!text) return null;
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM encrypted token
 */
export function decryptToken(encryptedString) {
  if (!encryptedString) return null;
  try {
    const parts = encryptedString.split(':');
    if (parts.length !== 3) return null;
    
    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = getKeyBuffer();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

/**
 * Generate SHA-256 hash for immutable content snapshots
 */
export function sha256(content) {
  return crypto.createHash('sha256').update(typeof content === 'string' ? content : JSON.stringify(content)).digest('hex');
}
