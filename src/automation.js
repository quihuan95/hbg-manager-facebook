import { db } from './db.js';
import { syncTopicsFromSheet } from './google/sheets.js';
import { resolveFolder, listFolderFiles, downloadFileContent } from './google/drive.js';
import { exportPostToDrive } from './google/export.js';
import { generateCaption } from './ai/caption.js';
import { generateImage, planImageBriefs } from './ai/image.js';
import { createPostFromTopic, createNewRevision, getPostById, updatePostStatus } from './models/post.js';
import { createRuleVersion, getLatestPublishedRule } from './models/rule.js';
import { approvePost } from './review/approval.js';
import { publishPostToFacebook } from './meta.js';
import crypto from 'node:crypto';
import { applyProfileLogo } from './image/logo.js';
import { applyDriveFrame, loadDriveImages } from './image/drive-assets.js';

function writeAutomationError(action, entityType, entityId, details) {
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, 'automation', ?, ?, ?, ?, ?)
  `).run(
    `audit_${crypto.randomUUID().slice(0, 12)}`,
    action,
    entityType,
    entityId,
    JSON.stringify(details),
    new Date().toISOString()
  );
}

function writeAutomationSuccess(action, entityType, entityId, details) {
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, 'automation', ?, ?, ?, ?, ?)
  `).run(`audit_${crypto.randomUUID().slice(0, 12)}`, action, entityType, entityId, JSON.stringify(details), new Date().toISOString());
}

export async function syncRulesFromDrive(profile) {
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

async function processTopic(profile, topic, scheduleOverride = null, scheduledRun = false) {
  const contentDate = scheduleOverride?.date || topic.content_date;
  const publishTime = scheduleOverride?.time || topic.publish_time || profile.time || '09:00';

  if (!contentDate || !publishTime) {
    writeAutomationError('CONTENT_GENERATION_FAILED', 'topic', topic.id, {
      profileId: profile.id,
      topicId: topic.topic_id,
      title: topic.topic_title,
      error: 'Thiếu content_date hoặc publish_time trong CONTENT_PLAN.'
    });
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

  // Approval is final. If Drive export previously failed, retry only the export step.
  if (post?.status === 'APPROVED') {
    try {
      const exported = await exportPostToDrive(post.id);
      return {
        topicId: topic.topic_id,
        title: topic.topic_title,
        status: 'exported',
        postId: post.id,
        driveFolderUrl: exported.driveFolderUrl
      };
    } catch (error) {
      writeAutomationError('DRIVE_EXPORT_FAILED', 'post', post.id, {
        profileId: profile.id,
        topicId: topic.topic_id,
        title: topic.topic_title,
        error: error.message
      });
      return { topicId: topic.topic_id, title: topic.topic_title, status: 'failed', postId: post.id, error: error.message };
    }
  }

  // A user-created post is authoritative. Scheduled automation may publish it when ready,
  // but must never regenerate its caption or image.
  if (post && scheduledRun && post.creation_source === 'manual') {
    return { topicId: topic.topic_id, title: topic.topic_title, status: 'skipped', postId: post.id };
  }

  if (!post) {
    post = createPostFromTopic(
      profile.id,
      topic.topic_title,
      contentDate,
      publishTime,
      topic.topic_id,
      scheduledRun ? 'automation' : 'manual'
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
      ''
    );
    post = createNewRevision(post.id, {
      caption: caption.caption,
      headline: caption.headline,
      cta: caption.cta,
      imageBrief: caption.imageBrief
    });

    updatePostStatus(post.id, 'GENERATING');
    const imageInstruction = topic.image_rule
      ? `Chủ đề: ${topic.topic_title}. Quy tắc hình ảnh riêng cho bài này: ${topic.image_rule}`
      : (post.image_brief || caption.imageBrief || '');
    const referenceImages = await loadDriveImages(topic.source_image_drive_link);
    const briefs = referenceImages.length
      ? referenceImages.map((source, index) => imageInstruction || `Tạo ảnh minh họa số ${index + 1} dựa sát trên ảnh nguồn này.`)
      : await planImageBriefs({ topic: topic.topic_title, caption: caption.caption, profileName: profile.name, ruleText: rule.content_markdown, customBrief: topic.image_rule || '' });
    const imageSet = [];
    for (let index = 0; index < briefs.length; index++) {
      const sources = referenceImages[index] ? [referenceImages[index]] : [];
      const image = await generateImage(topic.topic_title, profile.name, rule.content_markdown, briefs[index], sources);
      image.imageData = await applyProfileLogo(image.imageData, profile.logo_data);
      image.imageData = await applyDriveFrame(image.imageData, topic.image_frame_drive_link);
      imageSet.push({ data: image.imageData, mime: 'image/png', brief: briefs[index], sourceFileId: sources[0]?.id || null });
    }
    post = createNewRevision(post.id, {
      imageBrief: briefs.join('\n\n'),
      imageData: imageSet[0].data,
      imageMime: 'image/png',
      imageSet
    });

    approvePost(post.id, 'automation', { automated: true, source: 'CONTENT_PLAN' });
    const exported = await exportPostToDrive(post.id);
    writeAutomationSuccess('CONTENT_AUTOMATION_COMPLETED', 'post', post.id, {
      profileId: profile.id,
      title: topic.topic_title
    });

    return {
      topicId: topic.topic_id,
      title: topic.topic_title,
      status: 'exported',
      postId: post.id,
      driveFolderUrl: exported.driveFolderUrl
    };
  } catch (error) {
    updatePostStatus(post.id, 'DRAFT');
    writeAutomationError('CONTENT_GENERATION_FAILED', 'post', post.id, {
      profileId: profile.id,
      topicId: topic.topic_id,
      title: topic.topic_title,
      error: error.message
    });
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

function localDateTimeParts(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type)?.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}

async function publishDuePosts(profile) {
  const now = localDateTimeParts(profile.timezone || 'Asia/Ho_Chi_Minh');
  const posts = db.prepare(`
    SELECT id FROM posts
    WHERE profile_id = ?
      AND status IN ('APPROVED', 'READY_FOR_MANUAL_UPLOAD')
      AND (topic_id IS NULL OR EXISTS (
        SELECT 1 FROM topics t
        WHERE t.profile_id = posts.profile_id AND t.topic_id = posts.topic_id
      ))
      AND (content_date < ? OR (content_date = ? AND scheduled_time <= ?))
    ORDER BY content_date, scheduled_time, created_at
  `).all(profile.id, now.date, now.date, now.time);

  const results = [];
  for (const post of posts) {
    try {
      const published = await publishPostToFacebook(post.id, {
        uploaderId: 'automation',
        pageTarget: profile.facebook_page_id,
        note: 'Tự động đăng theo lịch của Content Profile'
      });
      writeAutomationSuccess('FACEBOOK_AUTO_PUBLISHED', 'post', post.id, {
        profileId: profile.id,
        postUrl: published.postUrl
      });
      results.push({ postId: post.id, success: true, postUrl: published.postUrl });
    } catch (error) {
      results.push({ postId: post.id, success: false, error: error.message });
      writeAutomationError('FACEBOOK_PUBLISH_FAILED', 'post', post.id, {
        profileId: profile.id,
        error: error.message
      });
    }
  }
  return results;
}

async function executeContentAutomation({ profileId = null, topicIds = null, scheduleOverrides = {}, scheduled = false } = {}) {
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
    profiles = db.prepare(`
      SELECT * FROM profiles
      WHERE active = 1 AND (? = 0 OR workflow_mode = 'auto')
      ORDER BY id
    `).all(scheduled ? 1 : 0);
  }

  if (profiles.length === 0) {
    if (scheduled) return {
      success: true,
      profiles: [],
      summary: { profiles: 0, profileErrors: 0, exported: 0, skipped: 0, failed: 0, published: 0, publishFailed: 0 }
    };
    throw new Error('Không có Content Profile đang hoạt động để xử lý.');
  }

  const report = [];
  for (const profile of profiles) {
    const profileResult = { profileId: profile.id, synced: null, rule: null, topics: [], publishing: [] };
    try {
      profileResult.rule = await syncRulesFromDrive(profile);
      if (!profile.sheet_id_topics) throw new Error('Chưa cấu hình Google Sheet CONTENT_PLAN.');
      profileResult.synced = await syncTopicsFromSheet(profile.id, profile.sheet_id_topics);

      let topicQuery = `
        SELECT * FROM topics
        WHERE profile_id = ?
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
        profileResult.topics.push(await processTopic(profile, topic, scheduleOverrides[topic.id] || null, scheduled));
      }
    } catch (error) {
      profileResult.error = error.message;
      writeAutomationError('AUTOMATION_PROFILE_FAILED', 'profile', profile.id, { error: error.message });
    }
    if (scheduled && profile.workflow_mode === 'auto') {
      try {
        profileResult.publishing = await publishDuePosts(profile);
      } catch (error) {
        profileResult.publishError = error.message;
      }
    }
    report.push(profileResult);
  }

  const allTopics = report.flatMap(item => item.topics);
  const allPublishing = report.flatMap(item => item.publishing || []);
  return {
    success: !report.some(item => item.error || item.publishError) && !allTopics.some(item => item.status === 'failed') && !allPublishing.some(item => !item.success),
    profiles: report,
    summary: {
      profiles: report.length,
      profileErrors: report.filter(item => item.error || item.publishError).length,
      exported: allTopics.filter(item => item.status === 'exported').length,
      skipped: allTopics.filter(item => item.status === 'skipped').length,
      failed: allTopics.filter(item => item.status === 'failed').length,
      published: allPublishing.filter(item => item.success).length,
      publishFailed: allPublishing.filter(item => !item.success).length
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
