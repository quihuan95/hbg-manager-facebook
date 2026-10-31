import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { config } from './src/config.js';
import { initDb, db } from './src/db.js';
import { getGoogleAuthUrl, handleGoogleCallback, getConnectionStatus } from './src/google/oauth.js';
import { probeDriveWrite, resolveFolder } from './src/google/drive.js';
import { syncTopicsFromSheet } from './src/google/sheets.js';
import { getAllProfiles, getProfileById, updateProfile, createProfile, deleteProfile } from './src/models/profile.js';
import { getAllRuleVersions, createRuleVersion, getLatestPublishedRule, deleteRuleVersions } from './src/models/rule.js';
import { getAllPosts, getPostById, createPostFromTopic, createNewRevision, updatePostStatus, deletePost } from './src/models/post.js';
import { generateCaption } from './src/ai/caption.js';
import { generateImage, planImageBriefs } from './src/ai/image.js';
import { approvePost, requestChanges } from './src/review/approval.js';
import { exportPostToDrive } from './src/google/export.js';
import { markManuallyUploaded, markManyManuallyUploaded } from './src/manual_upload.js';
import { runContentAutomation, syncRulesFromDrive } from './src/automation.js';
import { testMetaConnection, publishPostToFacebook } from './src/meta.js';
import { getAppSettings, saveAppSettings } from './src/settings.js';
import { applyProfileLogo } from './src/image/logo.js';
import { applyDriveFrame, loadDriveImages } from './src/image/drive-assets.js';
import { migrateBase64Media, resolveMediaPath } from './src/media.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, 'dist');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

// Initialize database schema and seeds
initDb();
const mediaMigration = migrateBase64Media(db);
if (mediaMigration.revisions || mediaMigration.profiles) {
  console.log(`[Media] Đã chuyển ${mediaMigration.revisions} ảnh bài viết và ${mediaMigration.profiles} logo ra thư mục AppData.`);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function logPostError(action, post, error) {
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, 'u_admin', ?, 'post', ?, ?, ?)
  `).run(
    `audit_${crypto.randomUUID().slice(0, 12)}`,
    action,
    post.id,
    JSON.stringify({ profileId: post.profile_id, title: post.topic_title, error: error.message }),
    new Date().toISOString()
  );
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 25 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/media/')) {
    const mediaPath = resolveMediaPath(pathname);
    if (!mediaPath || !fs.existsSync(mediaPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Media not found');
      return;
    }
    const stat = fs.statSync(mediaPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(mediaPath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(mediaPath).pipe(res);
    return;
  }

  // API Routes
  if (pathname.startsWith('/api/')) {
    try {
      // 1. Health
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'healthy', timestamp: new Date().toISOString() });
      }

      // 2. Status
      if (pathname === '/api/status' && req.method === 'GET') {
        const googleConn = getConnectionStatus();
        const isOpenAiConfigured = !!(config.openai.apiKey && config.openai.apiKey.startsWith('sk-'));
        const isMetaAppConfigured = !!(config.meta.appId && config.meta.appSecret);

        return sendJson(res, 200, {
          success: true,
          appVersion: APP_VERSION,
          env: config.env,
          timezone: config.timezone,
          publishMode: config.publishMode,
          runtime: {
            host: '127.0.0.1',
            port: server.address()?.port || config.port,
            baseUrl: `http://127.0.0.1:${server.address()?.port || config.port}`,
            googleRedirectUri: config.google.redirectUri
          },
          services: {
            openai: {
              configured: isOpenAiConfigured,
              textModel: config.openai.textModel,
              imageModel: config.openai.imageModel,
              detail: isOpenAiConfigured
                ? `Đã kết nối (${config.openai.textModel} / ${config.openai.imageModel})`
                : 'Chưa cấu hình OPENAI_API_KEY trong .env'
            },
            googleDrive: {
              configured: googleConn.status === 'active',
              status: googleConn.status,
              accountEmail: googleConn.account_email || null,
              detail: googleConn.status === 'active'
                ? `Đã liên kết tài khoản (${googleConn.account_email})`
                : (config.google.clientId ? 'Đã có Client ID · Chưa xác thực OAuth' : 'Chưa cấu hình Google Client ID')
            },
            facebook: {
              configured: isMetaAppConfigured,
              hasPageToken: Boolean(config.meta.pageAccessToken),
              status: config.meta.pageAccessToken
                ? 'page_connected'
                : (isMetaAppConfigured ? 'app_configured' : 'not_configured'),
              detail: config.meta.pageAccessToken
                ? 'Đã cấu hình Page Access Token · Sẵn sàng tự động đăng Facebook'
                : (isMetaAppConfigured
                  ? 'Meta App đã cấu hình · Chưa có Page Access Token'
                  : 'Chưa cấu hình META_APP_ID và META_APP_SECRET')
            },
            scheduler: {
              configured: config.automation.enabled,
              detail: config.automation.enabled
                ? `Tự động quét Sheet mỗi ${config.automation.intervalMinutes} phút · Múi giờ ${config.timezone}`
                : 'Đã tắt AUTOMATION_ENABLED'
            }
          }
        });
      }

      if (pathname === '/api/notifications' && req.method === 'GET') {
        const after = parsedUrl.searchParams.get('after') || new Date().toISOString();
        const notifications = db.prepare(`
          SELECT ae.id, ae.action, ae.entity_id, ae.details_json, ae.created_at,
                 COALESCE(r.topic_title, p.id) AS topic_title
          FROM audit_events ae
          LEFT JOIN posts p ON p.id = ae.entity_id
          LEFT JOIN post_revisions r ON r.id = p.current_revision_id
          WHERE ae.created_at > ?
            AND ae.action IN ('CONTENT_AUTOMATION_COMPLETED', 'FACEBOOK_AUTO_PUBLISHED')
          ORDER BY ae.created_at ASC
        `).all(after);
        return sendJson(res, 200, notifications);
      }

      // Local desktop configuration. Secret values are never returned to the renderer.
      if (pathname === '/api/app-config' && req.method === 'GET') {
        return sendJson(res, 200, { success: true, settings: getAppSettings() });
      }
      if (pathname === '/api/app-config' && req.method === 'PUT') {
        const body = await parseBody(req);
        return sendJson(res, 200, saveAppSettings(body.settings || {}));
      }
      if (pathname === '/api/app/restart' && req.method === 'POST') {
        const restartSupported = process.listenerCount('hbg-app-restart') > 0;
        sendJson(res, 200, { success: true, restartSupported });
        if (restartSupported) setTimeout(() => process.emit('hbg-app-restart'), 500).unref();
        return;
      }

      // 3. Google OAuth start
      if (pathname === '/api/oauth/google/start' && req.method === 'GET') {
        const url = getGoogleAuthUrl();
        return sendJson(res, 200, { url });
      }

      // 4. Google OAuth callback
      if (pathname === '/api/oauth/google/callback' && req.method === 'GET') {
        const code = parsedUrl.searchParams.get('code');
        const state = parsedUrl.searchParams.get('state');

        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Thiếu tham số OAuth callback.</h3>');
          return;
        }

        try {
          const user = await handleGoogleCallback(code, state);
          res.writeHead(302, { Location: '/#settings?oauth=success' });
          res.end();
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h3>Lỗi kết nối Google: ${err.message}</h3><p><a href="/#settings">Quay lại cài đặt</a></p>`);
          return;
        }
      }

      // 5. Test Google Drive Write Probe
      if (pathname === '/api/connections/google/test' && req.method === 'POST') {
        const body = await parseBody(req);
        const profileId = body.profileId || 'HBG_MICE';
        const folder = body.folderId || getProfileById(profileId)?.folder_id_output;
        if (!folder) {
          return sendJson(res, 400, { success: false, error: `Profile ${profileId} chưa cấu hình thư mục OUTPUT.` });
        }
        const root = await resolveFolder(folder);
        const probeResult = await probeDriveWrite(root.id);
        return sendJson(res, 200, probeResult);
      }

      // 6. Test Meta App credentials (does not connect a Facebook Page)
      if (pathname === '/api/connections/meta/test' && req.method === 'POST') {
        try {
          const result = await testMetaConnection();
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 502, {
            success: false,
            error: `Kiểm tra Meta thất bại: ${err.message}`,
            code: err.code || null
          });
        }
      }

      // 7. Profiles
      if (pathname === '/api/profiles' && req.method === 'GET') {
        return sendJson(res, 200, getAllProfiles());
      }
      if (pathname === '/api/profiles' && req.method === 'POST') {
        const body = await parseBody(req);
        const p = createProfile(body);
        return sendJson(res, 201, p);
      }
      if (pathname.startsWith('/api/profiles/') && req.method === 'PATCH') {
        const profileId = pathname.split('/')[3];
        const body = await parseBody(req);
        const p = updateProfile(profileId, body);
        return sendJson(res, 200, p);
      }
      if (pathname.match(/^\/api\/profiles\/([^/]+)$/) && req.method === 'DELETE') {
        const profileId = decodeURIComponent(pathname.split('/')[3]);
        return sendJson(res, 200, deleteProfile(profileId));
      }

      // 7. Rules for profile
      if (pathname.match(/^\/api\/profiles\/([^/]+)\/rules$/) && req.method === 'GET') {
        const profileId = pathname.split('/')[3];
        return sendJson(res, 200, getAllRuleVersions(profileId));
      }
      if (pathname.match(/^\/api\/profiles\/([^/]+)\/rules$/) && req.method === 'POST') {
        const profileId = pathname.split('/')[3];
        const body = await parseBody(req);
        const rv = createRuleVersion(profileId, body.contentMarkdown || body.rule);
        return sendJson(res, 201, rv);
      }
      if (pathname.match(/^\/api\/profiles\/([^/]+)\/rules$/) && req.method === 'DELETE') {
        const profileId = decodeURIComponent(pathname.split('/')[3]);
        return sendJson(res, 200, deleteRuleVersions(profileId));
      }

      // 8. Sync Topics from Sheet
      if (pathname.match(/^\/api\/profiles\/([^/]+)\/sync-sheet$/) && req.method === 'POST') {
        const profileId = pathname.split('/')[3];
        const body = await parseBody(req);
        const profile = getProfileById(profileId);
        if (!profile) return sendJson(res, 404, { error: 'Content Profile không tồn tại.' });
        const sheetId = body.sheetId || profile.sheet_id_topics;
        if (!sheetId) return sendJson(res, 400, { error: 'Chưa cấu hình Sheet ID cho Profile này.' });
        const rule = await syncRulesFromDrive(profile);
        const topics = await syncTopicsFromSheet(profileId, sheetId);
        return sendJson(res, 200, { ...topics, rule });
      }

      if (pathname === '/api/profiles/sync-all' && req.method === 'POST') {
        const profiles = getAllProfiles().filter(profile => profile.active && profile.sheet_id_topics);
        const results = [];
        for (const profile of profiles) {
          try {
            const rule = await syncRulesFromDrive(profile);
            const sync = await syncTopicsFromSheet(profile.id, profile.sheet_id_topics);
            results.push({ profileId: profile.id, profileName: profile.name, success: true, rule, ...sync });
          } catch (error) {
            results.push({ profileId: profile.id, profileName: profile.name, success: false, error: error.message });
          }
        }
        const summary = {
          profiles: profiles.length,
          succeeded: results.filter(item => item.success).length,
          failed: results.filter(item => !item.success).length,
          rulesUpdated: results.filter(item => item.success && item.rule?.changed).length,
          imported: results.reduce((sum, item) => sum + (item.imported || 0), 0),
          updated: results.reduce((sum, item) => sum + (item.updated || 0), 0),
          removed: results.reduce((sum, item) => sum + (item.removed || 0), 0),
          removedPosts: results.reduce((sum, item) => sum + (item.removedPosts || 0), 0),
          archivedPosts: results.reduce((sum, item) => sum + (item.archivedPosts || 0), 0)
        };
        return sendJson(res, summary.failed ? 207 : 200, { success: summary.failed === 0, summary, results });
      }

      // 8.1 List Synced Topics
      if (pathname === '/api/topics' && req.method === 'GET') {
        const profileId = parsedUrl.searchParams.get('profileId');
        const includeAll = parsedUrl.searchParams.get('all') === 'true';
        let query = `
          SELECT t.*, prof.name AS profile_name, prof.type AS profile_type,
                 p.id AS post_id, p.status AS post_status
          FROM topics t
          JOIN profiles prof ON prof.id = t.profile_id
          LEFT JOIN posts p ON p.id = (
            SELECT latest.id FROM posts latest
            WHERE latest.profile_id = t.profile_id AND latest.topic_id = t.topic_id
            ORDER BY latest.created_at DESC LIMIT 1
          )
          WHERE 1=1
        `;
        const params = [];
        // Every row synced from the Sheet is a confirmed topic.
        if (profileId) {
          query += ' AND t.profile_id = ?';
          params.push(profileId);
        }
        query += ' ORDER BY t.content_date ASC, t.publish_time ASC, t.topic_id ASC';
        return sendJson(res, 200, db.prepare(query).all(...params));
      }

      // Delete one synced topic from the tool. Existing generated posts are preserved.
      if (pathname.match(/^\/api\/topics\/([^/]+)$/) && req.method === 'DELETE') {
        const topicId = decodeURIComponent(pathname.split('/')[3]);
        const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
        if (!topic) return sendJson(res, 404, { success: false, error: 'Không tìm thấy lịch đã đồng bộ.' });

        const linkedPosts = db.prepare(`
          SELECT COUNT(*) AS count FROM posts
          WHERE profile_id = ? AND topic_id = ?
        `).get(topic.profile_id, topic.topic_id).count;
        const now = new Date().toISOString();

        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
          db.prepare(`
            INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
            VALUES (?, ?, 'SYNCED_TOPIC_DELETED', 'topic', ?, ?, ?)
          `).run(
            `audit_${crypto.randomUUID()}`,
            'u_admin',
            topicId,
            JSON.stringify({
              profile_id: topic.profile_id,
              topic_id: topic.topic_id,
              topic_title: topic.topic_title,
              preserved_posts: linkedPosts
            }),
            now
          );
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }

        return sendJson(res, 200, { success: true, id: topicId, preservedPosts: linkedPosts });
      }

      // 8.2 Fully automated Sheet -> Rule -> Caption -> Image -> Drive pipeline
      if (pathname === '/api/automation/run' && req.method === 'POST') {
        const body = await parseBody(req);
        const topicIds = Array.isArray(body.topicIds)
          ? [...new Set(body.topicIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
          : null;
        if (Array.isArray(topicIds) && topicIds.length === 0) {
          return sendJson(res, 400, { success: false, error: 'Hãy chọn ít nhất một lịch từ Sheet để tạo bài.' });
        }
        const scheduleOverrides = body.scheduleOverrides && typeof body.scheduleOverrides === 'object'
          ? body.scheduleOverrides
          : {};
        const result = await runContentAutomation({ profileId: body.profileId || null, topicIds, scheduleOverrides });
        return sendJson(res, result.success ? 200 : 207, result);
      }

      // 9. Posts List / Create
      if (pathname === '/api/posts' && req.method === 'GET') {
        const status = parsedUrl.searchParams.get('status');
        const profileId = parsedUrl.searchParams.get('profileId');
        return sendJson(res, 200, getAllPosts(status, profileId));
      }
      if (pathname === '/api/posts' && req.method === 'POST') {
        const body = await parseBody(req);
        const post = createPostFromTopic(body.profileId, body.topic, body.date, body.time, body.topicId);
        return sendJson(res, 201, post);
      }

      // 10. Single Post details
      if (pathname.match(/^\/api\/posts\/([^/]+)$/) && req.method === 'GET') {
        const postId = pathname.split('/')[3];
        const post = getPostById(postId);
        if (!post) return sendJson(res, 404, { error: 'Không tìm thấy bài viết.' });
        return sendJson(res, 200, post);
      }
      if (pathname.match(/^\/api\/posts\/([^/]+)$/) && req.method === 'DELETE') {
        const postId = pathname.split('/')[3];
        return sendJson(res, 200, deletePost(postId));
      }

      // 11. Generate Caption for Post
      if (pathname.match(/^\/api\/posts\/([^/]+)\/generate-caption$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const post = getPostById(postId);
        if (!post) return sendJson(res, 404, { error: 'Không tìm thấy bài viết.' });

        const rule = getLatestPublishedRule(post.profile_id);
        const body = await parseBody(req);

        updatePostStatus(postId, 'GENERATING');
        try {
          const aiResult = await generateCaption(post.topic_title, post.profile_name, rule?.content_markdown || '', body.promptContext || '');
          const updatedPost = createNewRevision(postId, {
            caption: aiResult.caption,
            headline: aiResult.headline,
            cta: aiResult.cta,
            imageBrief: aiResult.imageBrief
          });
          return sendJson(res, 200, { success: true, post: updatedPost, model: aiResult.model });
        } catch (err) {
          updatePostStatus(postId, 'DRAFT');
          logPostError('CAPTION_GENERATION_FAILED', post, err);
          throw err;
        }
      }

      // 12. Generate Image for Post
      if (pathname.match(/^\/api\/posts\/([^/]+)\/generate-image$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const post = getPostById(postId);
        if (!post) return sendJson(res, 404, { error: 'Không tìm thấy bài viết.' });

        const rule = getLatestPublishedRule(post.profile_id);
        const body = await parseBody(req);

        updatePostStatus(postId, 'GENERATING');
        try {
          const userPrompt = String(body.imageBrief || '').trim();
          const effectiveImageBrief = userPrompt
            ? [
                `Ưu tiên 1 — Prompt nhập tay: ${userPrompt}`,
                post.sheet_image_rule && `Ưu tiên 2 — Rule ảnh từ Sheet: ${post.sheet_image_rule}`
              ].filter(Boolean).join('\n\n')
            : (post.image_brief || post.sheet_image_rule || '');
          const referenceImages = await loadDriveImages(post.source_image_drive_link);
          const briefs = referenceImages.length
            ? referenceImages.map((source, index) => effectiveImageBrief || `Tạo ảnh minh họa số ${index + 1} cho bài viết dựa sát trên ảnh nguồn này.`)
            : await planImageBriefs({ topic: post.topic_title, caption: post.caption, profileName: post.profile_name, ruleText: rule?.content_markdown || '', customBrief: effectiveImageBrief });
          const imageSet = [];
          for (let index = 0; index < briefs.length; index++) {
            const sources = referenceImages[index] ? [referenceImages[index]] : [];
            const generated = await generateImage(post.topic_title, post.profile_name, rule?.content_markdown || '', briefs[index], sources);
            generated.imageData = await applyProfileLogo(generated.imageData, post.logo_data);
            generated.imageData = await applyDriveFrame(generated.imageData, post.image_frame_drive_link);
            imageSet.push({ data: generated.imageData, mime: 'image/png', brief: briefs[index], sourceFileId: sources[0]?.id || null });
          }
          const updatedPost = createNewRevision(postId, {
            imageBrief: briefs.join('\n\n'),
            imageData: imageSet[0].data,
            imageMime: 'image/png',
            imageSet
          }, body.expectedRevisionId);
          return sendJson(res, 200, { success: true, post: updatedPost, imageCount: imageSet.length });
        } catch (err) {
          updatePostStatus(postId, 'DRAFT');
          logPostError('IMAGE_GENERATION_FAILED', post, err);
          throw err;
        }
      }

      // Regenerate one image in the current image set without replacing the others.
      if (pathname.match(/^\/api\/posts\/([^/]+)\/generate-image\/(\d+)$/) && req.method === 'POST') {
        const match = pathname.match(/^\/api\/posts\/([^/]+)\/generate-image\/(\d+)$/);
        const postId = match[1];
        const imageIndex = Number(match[2]);
        const post = getPostById(postId);
        if (!post) return sendJson(res, 404, { error: 'Không tìm thấy bài viết.' });
        let imageSet = [];
        try { imageSet = JSON.parse(post.image_set_json || '[]'); } catch {}
        if (!imageSet.length && post.image_data) imageSet = [{ data: post.image_data, mime: post.image_mime || 'image/png', brief: post.image_brief || '' }];
        if (!imageSet[imageIndex]) return sendJson(res, 404, { error: 'Không tìm thấy ảnh cần tạo lại.' });

        const body = await parseBody(req);
        const rule = getLatestPublishedRule(post.profile_id);
        const brief = String(body.imageBrief || imageSet[imageIndex].brief || post.image_brief || '').trim();
        updatePostStatus(postId, 'GENERATING');
        try {
          const sourceImages = imageSet[imageIndex].sourceFileId
            ? await loadDriveImages(imageSet[imageIndex].sourceFileId, 1)
            : [];
          const generated = await generateImage(post.topic_title, post.profile_name, rule?.content_markdown || '', brief, sourceImages);
          generated.imageData = await applyProfileLogo(generated.imageData, post.logo_data);
          generated.imageData = await applyDriveFrame(generated.imageData, post.image_frame_drive_link);
          imageSet[imageIndex] = {
            ...imageSet[imageIndex],
            data: generated.imageData,
            mime: 'image/png',
            brief
          };
          const updatedPost = createNewRevision(postId, {
            imageData: imageSet[0].data,
            imageMime: imageSet[0].mime || 'image/png',
            imageBrief: imageSet.map(item => item.brief || '').filter(Boolean).join('\n\n'),
            imageSet
          }, body.expectedRevisionId);
          return sendJson(res, 200, { success: true, post: updatedPost, imageIndex });
        } catch (err) {
          updatePostStatus(postId, 'DRAFT');
          logPostError('SINGLE_IMAGE_REGENERATION_FAILED', post, err);
          throw err;
        }
      }

      // Replace one image manually, then apply the same logo/frame pipeline.
      if (pathname.match(/^\/api\/posts\/([^/]+)\/replace-image\/(\d+)$/) && req.method === 'POST') {
        const match = pathname.match(/^\/api\/posts\/([^/]+)\/replace-image\/(\d+)$/);
        const postId = match[1];
        const imageIndex = Number(match[2]);
        const post = getPostById(postId);
        if (!post) return sendJson(res, 404, { error: 'Không tìm thấy bài viết.' });
        const body = await parseBody(req);
        if (!String(body.imageData || '').startsWith('data:image/')) return sendJson(res, 400, { error: 'Dữ liệu ảnh không hợp lệ.' });
        let imageSet = [];
        try { imageSet = JSON.parse(post.image_set_json || '[]'); } catch {}
        if (!imageSet.length && post.image_data) imageSet = [{ data: post.image_data, mime: post.image_mime || 'image/png', brief: post.image_brief || '' }];
        if (!imageSet[imageIndex]) return sendJson(res, 404, { error: 'Không tìm thấy ảnh cần thay thế.' });
        let imageData = await applyProfileLogo(body.imageData, post.logo_data);
        imageData = await applyDriveFrame(imageData, post.image_frame_drive_link);
        imageSet[imageIndex] = { ...imageSet[imageIndex], data: imageData, mime: 'image/png' };
        const updatedPost = createNewRevision(postId, {
          imageData: imageSet[0].data,
          imageMime: imageSet[0].mime || 'image/png',
          imageSet
        }, body.expectedRevisionId);
        return sendJson(res, 200, { success: true, post: updatedPost, imageIndex });
      }

      // 13. Update Revision (Manual edit)
      if (pathname.match(/^\/api\/posts\/([^/]+)\/revisions$/) && req.method === 'PATCH') {
        const postId = pathname.split('/')[3];
        const body = await parseBody(req);
        const updatedPost = createNewRevision(postId, {
          caption: body.caption,
          headline: body.headline,
          cta: body.cta,
          imageData: body.imageData,
          imageMime: body.imageMime,
          imageSet: body.imageSet
        }, body.expectedRevisionId);

        return sendJson(res, 200, updatedPost);
      }

      // 14. Approve Post
      if (pathname.match(/^\/api\/posts\/([^/]+)\/approve$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const body = await parseBody(req);
        const approved = approvePost(postId, body.approverId || 'u_admin', body.checklist || {});
        try {
          const exported = await exportPostToDrive(postId);
          return sendJson(res, 200, { success: true, post: getPostById(postId), export: exported });
        } catch (error) {
          logPostError('DRIVE_EXPORT_FAILED', approved, error);
          throw new Error(`Bài đã được duyệt nhưng chưa thể xuất lên Drive: ${error.message}`);
        }
      }

      // 15. Request Changes
      if (pathname.match(/^\/api\/posts\/([^/]+)\/request-changes$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const body = await parseBody(req);
        const post = requestChanges(postId, body.actorId || 'u_admin', body.reason || '');
        return sendJson(res, 200, post);
      }

      // 16. Export Post to Drive
      if (pathname.match(/^\/api\/posts\/([^/]+)\/export$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const result = await exportPostToDrive(postId);
        return sendJson(res, 200, result);
      }

      // 17. Mark as Manually Uploaded
      if (pathname.match(/^\/api\/posts\/([^/]+)\/mark-manually-uploaded$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const body = await parseBody(req);
        const post = markManuallyUploaded(postId, body.uploaderId || 'u_admin', body.postUrl || '', body.note || '', body.pageTarget || '');
        return sendJson(res, 200, post);
      }

      // 17b. Mark selected posts as manually uploaded
      if (pathname === '/api/posts/bulk-mark-manually-uploaded' && req.method === 'POST') {
        const body = await parseBody(req);
        const result = markManyManuallyUploaded(body.postIds, body.uploaderId || 'u_admin', body.note || 'Đăng hàng loạt từ danh sách bài đã tạo');
        return sendJson(res, result.success ? 200 : 400, result);
      }

      // 17c. Auto-publish post to Facebook Page via Meta Graph API
      if (pathname.match(/^\/api\/posts\/([^/]+)\/publish-facebook$/) && req.method === 'POST') {
        const postId = pathname.split('/')[3];
        const body = await parseBody(req);
        const result = await publishPostToFacebook(postId, {
          pageTarget: body.pageTarget || null,
          uploaderId: body.uploaderId || 'u_admin',
          note: body.note || null
        });
        return sendJson(res, 200, result);
      }

      // 18. Audit Logs
      if (pathname === '/api/audit-logs/export' && req.method === 'GET') {
        const logs = db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC').all();
        const headers = ['created_at', 'action', 'actor_id', 'entity_type', 'entity_id', 'revision_id', 'details_json'];
        const csv = [headers.map(csvCell).join(','), ...logs.map(log => headers.map(key => csvCell(log[key])).join(','))].join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="hbg-system-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(`\uFEFF${csv}`);
        return;
      }
      if (pathname === '/api/audit-logs' && req.method === 'GET') {
        const requestedPage = Number.parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const requestedPageSize = Number.parseInt(parsedUrl.searchParams.get('pageSize') || '20', 10);
        const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
        const pageSize = Number.isFinite(requestedPageSize) ? Math.min(100, Math.max(10, requestedPageSize)) : 20;
        const total = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const currentPage = Math.min(page, totalPages);
        const logs = db.prepare(`
          SELECT * FROM audit_events
          ORDER BY CASE WHEN action LIKE '%FAILED%' OR action LIKE '%ERROR%' THEN 0 ELSE 1 END,
                   created_at DESC
          LIMIT ? OFFSET ?
        `).all(pageSize, (currentPage - 1) * pageSize);
        return sendJson(res, 200, { items: logs, pagination: { page: currentPage, pageSize, total, totalPages } });
      }
      if (pathname === '/api/audit-logs' && req.method === 'DELETE') {
        const deleted = db.prepare('DELETE FROM audit_events').run().changes;
        return sendJson(res, 200, { success: true, deleted });
      }

      return sendJson(res, 404, { success: false, error: 'API Endpoint không tồn tại.' });
    } catch (err) {
      console.error('Server error on route:', pathname, err);
      return sendJson(res, 400, { success: false, error: err.message || 'Internal Server Error' });
    }
  }

  // Static File Serving
  let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`====================================================`);
  console.log(`🚀 The HBG Content Studio Phase 1 (Production Backend)`);
  console.log(`👉 URL: http://localhost:${config.port}`);
  console.log(`👉 Database: ${config.dbPath}`);
  console.log(`👉 Google Redirect URI: ${config.google.redirectUri}`);
  console.log(`👉 Mode: ${config.publishMode.toUpperCase()} (Manual Upload)`);
  console.log(`👉 OpenAI: ${config.openai.textModel} / ${config.openai.imageModel}`);
  console.log(`====================================================`);

  if (config.automation.enabled) {
    const runScheduledAutomation = () => {
      runContentAutomation({ scheduled: true }).then(result => {
        const s = result.summary;
        console.log(`[Automation] Exported=${s.exported}, published=${s.published}, publishFailed=${s.publishFailed}, skipped=${s.skipped}, failed=${s.failed}, profileErrors=${s.profileErrors}`);
      }).catch(error => {
        console.error('[Automation] Run failed:', error.message);
      });
    };

    setTimeout(runScheduledAutomation, 10_000).unref();
    setInterval(runScheduledAutomation, config.automation.intervalMinutes * 60_000).unref();
    console.log(`⚡ Automation: ON · every ${config.automation.intervalMinutes} minutes`);
  }
});

export { server };
