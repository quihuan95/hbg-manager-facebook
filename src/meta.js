import { config } from './config.js';

const GRAPH_BASE_URL = 'https://graph.facebook.com';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Meta Graph API trả về HTTP ${response.status}`;
    const error = new Error(message);
    error.code = data?.error?.code || null;
    throw error;
  }
  return data;
}

export async function testMetaConnection() {
  if (!config.meta.appId || !config.meta.appSecret) {
    throw new Error('Chưa cấu hình META_APP_ID hoặc META_APP_SECRET.');
  }

  const tokenResponse = await fetch(`${GRAPH_BASE_URL}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      grant_type: 'client_credentials'
    })
  });
  const tokenData = await readJson(tokenResponse);

  if (!tokenData.access_token) {
    throw new Error('Meta không cấp App Access Token.');
  }

  const debugUrl = new URL(`${GRAPH_BASE_URL}/debug_token`);
  debugUrl.searchParams.set('input_token', tokenData.access_token);
  debugUrl.searchParams.set('access_token', tokenData.access_token);
  const debugResponse = await fetch(debugUrl);
  const debugData = await readJson(debugResponse);
  const tokenInfo = debugData.data || {};

  if (!tokenInfo.is_valid || String(tokenInfo.app_id) !== String(config.meta.appId)) {
    throw new Error('App Access Token không hợp lệ hoặc không khớp META_APP_ID.');
  }

  return {
    success: true,
    status: 'app_verified',
    appId: String(tokenInfo.app_id),
    tokenType: tokenInfo.type || 'APP',
    message: 'Kết nối Meta App thành công. App ID và App Secret hợp lệ.'
  };
}
