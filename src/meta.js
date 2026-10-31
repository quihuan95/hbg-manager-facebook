import { config } from './config.js';
import { readMediaBuffer } from './media.js';
import { db } from './db.js';
import { getPostById } from './models/post.js';
import { markManuallyUploaded } from './manual_upload.js';

const GRAPH_BASE_URL = 'https://graph.facebook.com';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Meta Graph API trả về HTTP ${response.status}`;
    const error = new Error(message);
    error.code = data?.error?.code || null;
    error.subcode = data?.error?.error_subcode || null;
    error.fbtrace_id = data?.error?.fbtrace_id || null;
    throw error;
  }
  return data;
}

export async function resolveFacebookPage(targetPage = null) {
  const token = config.meta.pageAccessToken;
  if (!token) {
    throw new Error('Chưa cấu hình FACEBOOK_PAGE_ACCESS_TOKEN trong file .env');
  }

  const version = config.meta.graphVersion || 'v26.0';
  const cleanVersion = version.startsWith('v') ? version : `v${version}`;

  // 1. Check if token is a User/System User token managing pages
  const accUrl = `${GRAPH_BASE_URL}/${cleanVersion}/me/accounts?fields=id,name,access_token,tasks`;
  const accRes = await fetch(accUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const accData = await accRes.json().catch(() => ({}));
  const pages = Array.isArray(accData?.data) ? accData.data : [];

  if (pages.length > 0) {
    if (targetPage) {
      const cleanTarget = String(targetPage).trim();
      let targetId = cleanTarget;
      if (!/^\d+$/.test(cleanTarget)) {
        const match = cleanTarget.match(/\/(?:pages\/[^/]+\/)?(\d+)/) || cleanTarget.match(/facebook\.com\/([^/?#]+)/);
        if (match && match[1]) targetId = match[1];
      }

      const found = pages.find(p => p.id === targetId || p.id === cleanTarget || p.name.toLowerCase() === cleanTarget.toLowerCase());
      if (found) {
        return {
          pageId: found.id,
          pageName: found.name,
          accessToken: found.access_token || token
        };
      }
    }

    // Default to the first page if only 1 page is managed
    if (pages.length === 1) {
      return {
        pageId: pages[0].id,
        pageName: pages[0].name,
        accessToken: pages[0].access_token || token
      };
    }

    throw new Error(`Tài khoản quản lý ${pages.length} Pages (${pages.map(p => p.name).join(', ')}). Vui lòng cấu hình đúng Page ID trong Profile.`);
  }

  // 2. Token might be a direct Page Access Token
  const meRes = await fetch(`${GRAPH_BASE_URL}/${cleanVersion}/me?fields=id,name`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meData = await meRes.json().catch(() => ({}));
  if (meRes.ok && meData?.id) {
    return {
      pageId: meData.id,
      pageName: meData.name || 'Facebook Page',
      accessToken: token
    };
  }

  throw new Error(accData?.error?.message || meData?.error?.message || 'Không thể xác thực Facebook Page Access Token.');
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

  let connectedPage = null;
  if (config.meta.pageAccessToken) {
    try {
      connectedPage = await resolveFacebookPage();
    } catch (pageErr) {
      return {
        success: true,
        status: 'app_verified_page_error',
        appId: String(tokenInfo.app_id),
        message: `App ID & Secret hợp lệ, nhưng Page Token cảnh báo: ${pageErr.message}`
      };
    }
  }

  const message = connectedPage
    ? `Kết nối Meta App và Fanpage "${connectedPage.pageName}" (ID: ${connectedPage.pageId}) thành công!`
    : 'Kết nối Meta App thành công. App ID và App Secret hợp lệ.';

  return {
    success: true,
    status: connectedPage ? 'page_connected' : 'app_verified',
    appId: String(tokenInfo.app_id),
    tokenType: tokenInfo.type || 'APP',
    connectedPage,
    message
  };
}

export async function publishPostToFacebook(postId, options = {}) {
  const post = getPostById(postId);
  if (!post) throw new Error('Không tìm thấy bài viết.');

  const targetPage = options.pageTarget || post.facebook_page_id || null;
  const { pageId, pageName, accessToken } = await resolveFacebookPage(targetPage);

  const rev = db.prepare('SELECT * FROM post_revisions WHERE id = ?').get(post.current_revision_id);
  if (!rev) throw new Error('Không tìm thấy revision bài viết.');

  const parts = [];
  if (rev.headline && rev.headline.trim()) parts.push(rev.headline.trim());
  if (rev.caption && rev.caption.trim()) parts.push(rev.caption.trim());
  if (rev.cta && rev.cta.trim()) parts.push(rev.cta.trim());
  const message = parts.join('\n\n').trim() || post.topic_title || '';

  const version = config.meta.graphVersion || 'v26.0';
  const cleanVersion = version.startsWith('v') ? version : `v${version}`;

  let result;
  if (rev.image_data) {
    let imageSet = [];
    try { imageSet = JSON.parse(rev.image_set_json || '[]'); } catch {}
    if (!imageSet.length) imageSet = [{ data: rev.image_data, mime: rev.image_mime || 'image/png' }];
    const uploadedMedia = [];
    for (let index = 0; index < imageSet.length; index++) {
      const item = imageSet[index];
      const mime = item.mime || 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
      const imgBuffer = readMediaBuffer(item.data);
      if (!imgBuffer) throw new Error(`Không đọc được file ảnh số ${index + 1} trong thư mục dữ liệu ứng dụng.`);
      const formData = new FormData();
      formData.append('source', new Blob([imgBuffer], { type: mime }), `image-${index + 1}.${ext}`);
      formData.append('published', 'false');
      const uploadUrl = `${GRAPH_BASE_URL}/${cleanVersion}/${pageId}/photos?access_token=${encodeURIComponent(accessToken)}`;
      const uploadData = await readJson(await fetch(uploadUrl, { method: 'POST', body: formData }));
      if (!uploadData?.id) throw new Error(`Không thể tải ảnh số ${index + 1} lên Facebook.`);
      uploadedMedia.push({ media_fbid: uploadData.id });
    }

    // Bước 2: Đăng bài viết lên thẳng Dòng thời gian / Tab Bài viết (Page Feed) với ảnh đính kèm
    const feedUrl = `${GRAPH_BASE_URL}/${cleanVersion}/${pageId}/feed`;
    const feedRes = await fetch(feedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        message,
        attached_media: JSON.stringify(uploadedMedia),
        published: 'true',
        access_token: accessToken
      })
    });
    result = await readJson(feedRes);
  } else {
    const feedUrl = `${GRAPH_BASE_URL}/${cleanVersion}/${pageId}/feed`;
    const feedRes = await fetch(feedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        message,
        published: 'true',
        access_token: accessToken
      })
    });
    result = await readJson(feedRes);
  }

  const fbPostId = result.post_id || result.id;
  const postUrl = fbPostId ? `https://facebook.com/${fbPostId}` : `https://facebook.com/${pageId}`;

  // Ghi nhận bài đã đăng vào manual_uploads và đổi trạng thái bài viết
  markManuallyUploaded(
    postId,
    options.uploaderId || 'u_admin',
    postUrl,
    options.note || `Đã tự động đăng lên Fanpage "${pageName}" qua Meta Graph API`,
    pageId
  );

  return {
    success: true,
    postUrl,
    pageId,
    pageName,
    facebookPostId: fbPostId,
    message: `Đã đăng bài thành công lên Fanpage "${pageName}"!`
  };
}
