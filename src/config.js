import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function loadEnv() {
  const envPath = process.env.HBG_ENV_PATH
    ? path.resolve(process.env.HBG_ENV_PATH)
    : path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
}

loadEnv();

export const config = {
  env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
  port: parseInt(process.env.API_PORT || process.env.PORT || '8080', 10),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:8080',
  timezone: process.env.DEFAULT_TIMEZONE || process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh',
  publishMode: process.env.PUBLISH_MODE || 'manual',
  driveOutputRequired: process.env.DRIVE_OUTPUT_REQUIRED !== 'false',
  automation: {
    enabled: process.env.AUTOMATION_ENABLED !== 'false',
    intervalMinutes: Math.max(1, parseInt(process.env.AUTOMATION_INTERVAL_MINUTES || '5', 10))
  },

  // Database
  dbPath: process.env.HBG_DATA_DIR
    ? path.resolve(process.env.HBG_DATA_DIR, 'content_studio.sqlite')
    : path.resolve(rootDir, 'data', 'content_studio.sqlite'),

  // Google OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8080/api/oauth/google/callback',
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]
  },

  // Encryption & Auth
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
  authSecret: process.env.AUTH_SECRET || 'hbg-secret-salt-2026',

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    textModel: process.env.TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    imageModel: process.env.IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
  },

  // Meta / Facebook Pages
  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || ''
  }
};
