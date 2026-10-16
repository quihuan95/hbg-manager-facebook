import { db } from './db.js';
import { syncTopicsFromSheet } from './google/sheets.js';
import { resolveFolder, listFolderFiles, downloadFileContent } from './google/drive.js';
import { exportPostToDrive } from './google/export.js';
import { generateCaption } from './ai/caption.js';
import { generateImage } from './ai/image.js';
import { createPostFromTopic, createNewRevision, getPostById, updatePostStatus } from './models/post.js';
import { createRuleVersion, getLatestPublishedRule } from './models/rule.js';
import { approvePost } from './review/approval.js';

function topicContext(topic) {
  return [
    topic.content_type && `Loại nội dung: ${topic.content_type}`,
    topic.audience && `Đối tượng: ${topic.audience}`,
    topic.key_message && `Thông điệp chính: ${topic.key_message}`,
    topic.facts && `Dữ kiện được phép dùng: ${topic.facts}`,
    topic.fact_source_ids && `Nguồn dữ kiện: ${topic.fact_source_ids}`,
    topic.cta && `CTA yêu cầu: ${topic.cta}`,
    topic.required_text && `Nội dung bắt buộc: ${topic.required_text}`
  ].filter(Boolean).join('\n');
}

async function syncRulesFromDrive(profile) {
  const rulesFolder = profile.folder_id_rules
    || profile.folder_id_output?.replace(/\/OUTPUT\/?$/i, '/RULES');
  if (!rulesFolder) return { changed: false, reason: 'no_rules_folder' };

  const folder = await resolveFolder(rulesFolder);
  const files = await listFolderFiles(folder.id);
  const wanted = ['CONTENT_RULE.md', 'BRAND_FACTS.md', 'IMAGE_RULE.md'];
  const sections = [];

  for (const name of wanted) {
    const file = files.find(item => item.name === name);
    if (!file) continue;
    const content = await downloadFileContent(file.id, file.mimeType);
    sections.push(`# ${name}\n\n${content.trim()}`);
  }

  if (sections.length === 0) return { changed: false, reason: 'no_rule_files' };

  const combined = sections.join('\n\n---\n\n');
  const latest = getLatestPublishedRule(profile.id);
  if (latest?.content_markdown === combined) {
    return { changed: false, version: latest.version };
  }

  const publishConfigFile = files.find(item => item.name === 'PUBLISH_CONFIG.json');
  let publishConfig = null;
  if (publishConfigFile) {
    const raw = await downloadFileContent(publishConfigFile.id, publishConfigFile.mimeType);
    try { publishConfig = JSON.parse(raw); } catch { /* Keep automation usable if optional config is invalid. */ }
  }

  const created = createRuleVersion(profile.id, combined, publishConfig, 'automation');
  return { changed: true, version: created.version };
}

async function processTopic(profile, topic, scheduleOverride = null) {
  const contentDate = scheduleOverride?.date || topic.content_date;
  const publishTime = scheduleOverride?.time || topic.publish_time || profile.time || '09:00';

  if (!contentDate || !publishTime) {
    return {
      topicId: topic.topic_id,
      title: topic.topic_title,
      status: 'failed',
      error: 'Topic READY phải có content_date và publish_time trong CONTENT_PLAN.'
    };
  }

  let post = db.prepare(`
    SELECT * FROM posts
    WHERE profile_id = ? AND topic_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(profile.id, topic.topic_id);

  if (post && ['READY_FOR_MANUAL_UPLOAD', 'MANUALLY_UPLOADED'].includes(post.status)) {
    return { topicId: topic.topic_id, title: topic.topic_title, status: 'skipped', postId: post.id };
  }

  if (!post) {
    post = createPostFromTopic(
      profile.id,
      topic.topic_title,
      contentDate,
      publishTime,
      topic.topic_id
    );
  } else {
    post = getPostById(post.id);
  }

  try {
    const rule = getLatestPublishedRule(profile.id);
    if (!rule) throw new Error('Profile chưa có Rule được kích hoạt.');

    updatePostStatus(post.id, 'GENERATING');
    const caption = await generateCaption(
      topic.topic_title,
      profile.name,
      rule.content_markdown,
      topicContext(topic)
    );
    post = createNewRevision(post.id, {
      caption: caption.caption,
      headline: caption.headline,
      cta: topic.cta || caption.cta,
      imageBrief: caption.imageBrief
    });

    updatePostStatus(post.id, 'GENERATING');
    const image = await generateImage(
      topic.topic_title,
      profile.name,
      rule.content_markdown,
      post.image_brief || caption.imageBrief
    );
    post = createNewRevision(post.id, {
      imageData: image.imageData,
      imageMime: image.imageMime
    });

    approvePost(post.id, 'automation', { automated: true, source: 'CONTENT_PLAN' });
    const exported = await exportPostToDrive(post.id);

    return {
      topicId: topic.topic_id,
      title: topic.topic_title,
      status: 'exported',
      postId: post.id,
      driveFolderUrl: exported.driveFolderUrl
    };
  } catch (error) {
    updatePostStatus(post.id, 'DRAFT');
    return {
      topicId: topic.topic_id,
      title: topic.topic_title,
      status: 'failed',
      postId: post.id,
      error: error.message
    };
  }
}

let activeRun = null;

async function executeContentAutomation({ profileId = null, topicIds = null, scheduleOverrides = {} } = {}) {
  let profiles;
  if (profileId) {
    profiles = db.prepare('SELECT * FROM profiles WHERE id = ? AND active = 1').all(profileId);
  } else if (Array.isArray(topicIds)) {
    profiles = topicIds.length
      ? db.prepare(`
          SELECT DISTINCT p.* FROM profiles p
          JOIN topics t ON t.profile_id = p.id
          WHERE p.active = 1 AND t.id IN (${topicIds.map(() => '?').join(', ')})
          ORDER BY p.id
        `).all(...topicIds)
      : [];
  } else {
    profiles = db.prepare('SELECT * FROM profiles WHERE active = 1 ORDER BY id').all();
  }

  if (profiles.length === 0) throw new Error('Không có Content Profile đang hoạt động để chạy tự động.');

  const report = [];
  for (const profile of profiles) {
    const profileResult = { profileId: profile.id, synced: null, rule: null, topics: [] };
    try {
      profileResult.rule = await syncRulesFromDrive(profile);
      if (!profile.sheet_id_topics) throw new Error('Chưa cấu hình Google Sheet CONTENT_PLAN.');
      profileResult.synced = await syncTopicsFromSheet(profile.id, profile.sheet_id_topics);

      let topicQuery = `
        SELECT * FROM topics
        WHERE profile_id = ?
          AND ${Array.isArray(topicIds) ? "status <> 'DISABLED'" : "status = 'READY'"}
      `;
      const topicParams = [profile.id];
      if (Array.isArray(topicIds)) {
        if (topicIds.length === 0) {
          profileResult.topics = [];
          report.push(profileResult);
          continue;
        }
        topicQuery += ` AND id IN (${topicIds.map(() => '?').join(', ')})`;
        topicParams.push(...topicIds);
      }
      topicQuery += ' ORDER BY content_date ASC, publish_time ASC, topic_id ASC';
      const topics = db.prepare(topicQuery).all(...topicParams);

      for (const topic of topics) {
        profileResult.topics.push(await processTopic(profile, topic, scheduleOverrides[topic.id] || null));
      }
    } catch (error) {
      profileResult.error = error.message;
    }
    report.push(profileResult);
  }

  const allTopics = report.flatMap(item => item.topics);
  return {
    success: !report.some(item => item.error) && !allTopics.some(item => item.status === 'failed'),
    profiles: report,
    summary: {
      profiles: report.length,
      profileErrors: report.filter(item => item.error).length,
      exported: allTopics.filter(item => item.status === 'exported').length,
      skipped: allTopics.filter(item => item.status === 'skipped').length,
      failed: allTopics.filter(item => item.status === 'failed').length
    }
  };
}

export function runContentAutomation(options = {}) {
  if (activeRun) return activeRun;
  activeRun = executeContentAutomation(options).finally(() => {
    activeRun = null;
  });
  return activeRun;
}
