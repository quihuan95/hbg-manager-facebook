import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEYS = new Set([
  'OPENAI_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'META_APP_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'AUTH_SECRET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY'
]);

export const SETTING_KEYS = [
  'NODE_ENV',
  'APP_TIMEZONE',
  'PUBLISH_MODE',
  'DRIVE_OUTPUT_REQUIRED',
  'AUTOMATION_ENABLED',
  'AUTOMATION_INTERVAL_MINUTES',
  'OPENAI_API_KEY',
  'OPENAI_TEXT_MODEL',
  'OPENAI_IMAGE_MODEL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_GRAPH_VERSION',
  'TOKEN_ENCRYPTION_KEY',
  'AUTH_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY'
];

function envPath() {
  return path.resolve(process.env.HBG_ENV_PATH || path.join(process.cwd(), '.env'));
}

function parseEnv(content = '') {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function readValues() {
  const file = envPath();
  return parseEnv(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
}

export function getAppSettings() {
  const values = readValues();
  return Object.fromEntries(SETTING_KEYS.map(key => {
    const value = values.get(key) || '';
    return [key, {
      secret: SECRET_KEYS.has(key),
      configured: Boolean(value && !/^(REPLACE_|CONFIGURE_)/.test(value)),
      value: SECRET_KEYS.has(key) ? '' : value
    }];
  }));
}

export function saveAppSettings(input = {}) {
  const file = envPath();
  const values = readValues();

  for (const key of SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const raw = input[key];
    if (typeof raw !== 'string') throw new Error(`${key} phải là chuỗi.`);
    const value = raw.trim();
    if (/\r|\n/.test(value)) throw new Error(`${key} không được chứa ký tự xuống dòng.`);
    if (SECRET_KEYS.has(key) && !value) continue;
    values.set(key, value);
  }

  const knownLines = SETTING_KEYS.map(key => `${key}=${values.get(key) || ''}`);
  const extraLines = [...values.entries()]
    .filter(([key]) => !SETTING_KEYS.includes(key))
    .map(([key, value]) => `${key}=${value}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[...knownLines, ...extraLines].join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });

  return { success: true, restartRequired: true, settings: getAppSettings() };
}
