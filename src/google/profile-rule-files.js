import { listFolderFiles, resolveFolder, uploadFileToDrive } from './drive.js';

const RULE_FILE_TEMPLATES = {
  'CONTENT_RULE.md': profile => `# CONTENT_RULE

## Profile

- Profile ID: ${profile.id}
- Profile name: ${profile.name}
- Product scope: ${profile.type || profile.brand || 'Chưa cấu hình'}
- Language: ${profile.language || 'vi'}

## Content rules

<!-- Bổ sung quy tắc viết nội dung cho profile này. -->
`,
  'BRAND_FACTS.md': profile => `# BRAND_FACTS

## Brand

- Profile: ${profile.name}
- Brand: ${profile.brand || profile.name}

## Verified facts

<!-- Chỉ bổ sung những thông tin thương hiệu đã được xác minh. -->
`,
  'IMAGE_RULE.md': profile => `# IMAGE_RULE

## Profile

- Profile: ${profile.name}
- Default size: 1200x1200

## Image rules

<!-- Bổ sung quy tắc hình ảnh cho profile này. -->
`,
  'PUBLISH_CONFIG.json': profile => `${JSON.stringify({
    schema_version: 1,
    profile_id: profile.id,
    profile_name: profile.name,
    product_scope: profile.type || profile.brand || '',
    enabled: Boolean(profile.active),
    approval_required: profile.workflow_mode !== 'auto',
    timezone: profile.timezone || 'Asia/Ho_Chi_Minh',
    language: profile.language || 'vi',
    facebook_page_id: profile.facebook_page_id || null,
    rules_folder_url: profile.folder_id_rules || null,
    topics_spreadsheet_url: profile.sheet_id_topics || null,
    topics_tab: 'TOPICS',
    materials_folder_url: profile.folder_id_materials || null,
    output_folder_url: profile.folder_id_output || null,
    publish_time: profile.time || '09:00',
    publish_time_status: 'PROPOSED',
    rule_status: 'REVIEW_BEFORE_ACTIVATION',
    rule_version: '1.0-draft',
    image_preset: { width: 1200, height: 1200 },
    max_posts_per_day: 1,
    on_missing_source: 'HOLD',
    on_rule_conflict: 'HOLD',
    on_unknown_publish: 'RECONCILE_NO_AUTO_RETRY',
    credentials_storage: 'SERVER_ONLY'
  }, null, 2)}\n`
};

export function buildProfileRuleFiles(profile) {
  return Object.fromEntries(
    Object.entries(RULE_FILE_TEMPLATES).map(([name, render]) => [name, render(profile)])
  );
}

export async function initializeProfileRuleFiles(profile) {
  const rulesFolder = profile.folder_id_rules
    || profile.folder_id_output?.replace(/\/OUTPUT\/?$/i, '/RULES');
  if (!rulesFolder) {
    throw new Error('Cần cấu hình thư mục RULES trước khi tạo Profile.');
  }

  const folder = await resolveFolder(rulesFolder);
  const existingNames = new Set((await listFolderFiles(folder.id)).map(file => file.name));
  const templates = buildProfileRuleFiles(profile);
  const created = [];
  const existing = [];

  for (const [name, content] of Object.entries(templates)) {
    if (existingNames.has(name)) {
      existing.push(name);
      continue;
    }
    const mimeType = name.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/markdown; charset=utf-8';
    await uploadFileToDrive(folder.id, name, mimeType, Buffer.from(content, 'utf8'));
    created.push(name);
  }

  return { folderId: folder.id, created, existing };
}
