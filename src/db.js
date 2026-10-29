import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new DatabaseSync(config.dbPath);

// Enable WAL mode for high concurrency
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin', -- admin, editor, approver
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT,
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL, -- 'google'
      user_id TEXT NOT NULL,
      encrypted_tokens TEXT NOT NULL,
      scopes TEXT NOT NULL,
      account_email TEXT,
      account_name TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active, needs_reconnect
      last_health_check TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      brand TEXT,
      language TEXT NOT NULL DEFAULT 'vi',
      timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      folder_id_rules TEXT,
      folder_id_topics TEXT,
      folder_id_materials TEXT,
      folder_id_output TEXT,
      sheet_id_topics TEXT,
      page_name TEXT,
      facebook_page_id TEXT,
      color TEXT NOT NULL DEFAULT '#4970d5',
      workflow_mode TEXT NOT NULL DEFAULT 'manual',
      retain_removed_posts INTEGER NOT NULL DEFAULT 1,
      logo_data TEXT,
      logo_mime TEXT,
      time TEXT NOT NULL DEFAULT '09:00',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_versions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      publish_config_json TEXT,
      hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published', -- published, draft, retired
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      content_date TEXT NOT NULL,
      topic_title TEXT NOT NULL,
      content_type TEXT,
      audience TEXT,
      key_message TEXT,
      facts TEXT,
      fact_source_ids TEXT,
      asset_folder_id TEXT,
      publish_time TEXT,
      language TEXT DEFAULT 'vi',
      cta TEXT,
      required_text TEXT,
      image_rule TEXT,
      status TEXT NOT NULL DEFAULT 'READY', -- Rows present in Sheet are confirmed.
      source_hash TEXT NOT NULL,
      source_revision INTEGER NOT NULL DEFAULT 1,
      imported_at TEXT NOT NULL,
      UNIQUE(profile_id, topic_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      topic_id TEXT,
      content_date TEXT NOT NULL,
      scheduled_time TEXT NOT NULL DEFAULT '09:00',
      current_revision_id TEXT,
      creation_source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, GENERATING, NEEDS_REVIEW, APPROVED, READY_FOR_MANUAL_UPLOAD, MANUALLY_UPLOADED, ARCHIVED
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS post_revisions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      parent_revision_id TEXT,
      topic_title TEXT NOT NULL,
      caption TEXT NOT NULL,
      headline TEXT,
      cta TEXT,
      image_brief TEXT,
      image_data TEXT, -- Internal /media URL; binary content is stored under AppData.
      image_mime TEXT,
      image_dimensions TEXT,
      rule_version_id TEXT,
      rule_hash TEXT,
      topic_snapshot_json TEXT,
      validation_findings_json TEXT,
      revision_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      checklist_json TEXT,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (revision_id) REFERENCES post_revisions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      drive_folder_id TEXT,
      drive_caption_file_id TEXT,
      drive_image_file_id TEXT,
      drive_manifest_file_id TEXT,
      drive_review_file_id TEXT,
      status TEXT NOT NULL DEFAULT 'NOT_STARTED', -- NOT_STARTED, EXPORTING, PARTIAL, EXPORTED, FAILED
      error_message TEXT,
      exported_at TEXT,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (revision_id) REFERENCES post_revisions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS manual_uploads (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      uploader_id TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      post_url TEXT,
      note TEXT,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      stage TEXT NOT NULL, -- caption, image, export
      state TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, COMPLETED, FAILED
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      idempotency_key TEXT UNIQUE,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      revision_id TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Lightweight migration for databases created before Facebook Page mapping existed.
  const profileColumns = db.prepare('PRAGMA table_info(profiles)').all();
  if (!profileColumns.some(column => column.name === 'facebook_page_id')) {
    db.exec('ALTER TABLE profiles ADD COLUMN facebook_page_id TEXT');
  }
  if (!profileColumns.some(column => column.name === 'color')) {
    db.exec("ALTER TABLE profiles ADD COLUMN color TEXT NOT NULL DEFAULT '#4970d5'");
    const palette = ['#4970d5', '#0f8b8d', '#e07a2d', '#9b5de5', '#d1495b', '#2a9d5b', '#c49000', '#52796f'];
    db.prepare('SELECT id FROM profiles ORDER BY created_at, id').all().forEach((profile, index) => {
      db.prepare('UPDATE profiles SET color = ? WHERE id = ?').run(palette[index % palette.length], profile.id);
    });
  }
  if (!profileColumns.some(column => column.name === 'workflow_mode')) {
    db.exec("ALTER TABLE profiles ADD COLUMN workflow_mode TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!profileColumns.some(column => column.name === 'retain_removed_posts')) {
    db.exec('ALTER TABLE profiles ADD COLUMN retain_removed_posts INTEGER NOT NULL DEFAULT 1');
  }
  if (!profileColumns.some(column => column.name === 'logo_data')) db.exec('ALTER TABLE profiles ADD COLUMN logo_data TEXT');
  if (!profileColumns.some(column => column.name === 'logo_mime')) db.exec('ALTER TABLE profiles ADD COLUMN logo_mime TEXT');
  const topicColumns = db.prepare('PRAGMA table_info(topics)').all();
  if (!topicColumns.some(column => column.name === 'image_rule')) {
    db.exec('ALTER TABLE topics ADD COLUMN image_rule TEXT');
  }
  const postColumns = db.prepare('PRAGMA table_info(posts)').all();
  if (!postColumns.some(column => column.name === 'creation_source')) {
    db.exec("ALTER TABLE posts ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'manual'");
  }
  // A row present in CONTENT_PLAN is considered confirmed; legacy HOLD/DISABLED values no longer gate processing.
  db.prepare("UPDATE topics SET status = 'READY' WHERE status <> 'READY'").run();
  const manualUploadColumns = db.prepare('PRAGMA table_info(manual_uploads)').all();
  if (!manualUploadColumns.some(column => column.name === 'target_page')) {
    db.exec('ALTER TABLE manual_uploads ADD COLUMN target_page TEXT');
  }

  // Seed default admin user if not exists
  const userCheck = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@thehbg.vn');
  if (!userCheck) {
    db.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('u_admin', 'admin@thehbg.vn', 'Minh Phạm', 'admin', new Date().toISOString());
  }

  // Seed default profiles if table empty
  const profileCount = db.prepare('SELECT COUNT(*) as cnt FROM profiles').get();
  if (profileCount.cnt === 0) {
    const defaultProfiles = [
      {
        id: 'HBG_MICE',
        name: 'The HBG M.I.C.E',
        type: 'Hội nghị',
        brand: 'The HBG',
        folder_rules: 'HBG_MICE/RULES',
        folder_topics: 'HBG_MICE/TOPICS',
        folder_materials: 'HBG_MICE/MATERIALS',
        folder_output: 'HBG_MICE/OUTPUT',
        time: '09:00',
        rule: `Dịch vụ hội nghị thuộc The HBG M.I.C.E – một thương hiệu nằm trong hệ sinh thái The HBG.\nĐối tượng: Event Manager, Điều phối dự án, Ban tổ chức.\nTập trung: một đầu mối, giấy phép, protocol, quy trình thực chiến.\nKhông bịa case, giá hoặc ưu đãi. Không dùng “không chỉ … mà còn …”.\nẢnh: xanh dương – vàng – trắng; ít text; không thêm slogan ở 3 góc. Logo gốc đặt bằng lớp riêng.`
      },
      {
        id: 'HBG_TOURIST',
        name: 'The HBG Tourist',
        type: 'Du lịch',
        brand: 'The HBG',
        folder_rules: 'HBG_TOURIST/RULES',
        folder_topics: 'HBG_TOURIST/TOPICS',
        folder_materials: 'HBG_TOURIST/MATERIALS',
        folder_output: 'HBG_TOURIST/OUTPUT',
        time: '10:30',
        rule: `Sản phẩm du lịch thuộc The HBG Tourist – một thương hiệu nằm trong hệ sinh thái The HBG.\nĐối tượng: HR/Admin, khách đoàn doanh nghiệp.\nDùng nguyên liệu đã xác minh; không tự tạo giá tour, lịch trình, cam kết dịch vụ.\nẢnh: xanh du lịch, trắng; logo gốc; không dùng ảnh tạo để chứng minh chuyến đi thực tế.`
      },
      {
        id: 'DANANG_EVENTS',
        name: 'Danang Events',
        type: 'Hội nghị',
        brand: 'Danang Events',
        folder_rules: 'DANANG_EVENTS/RULES',
        folder_topics: 'DANANG_EVENTS/TOPICS',
        folder_materials: 'DANANG_EVENTS/MATERIALS',
        folder_output: 'DANANG_EVENTS/OUTPUT',
        time: '14:00',
        rule: `Danang Events là thương hiệu độc lập.\nHội nghị quốc tế tại Đà Nẵng/miền Trung. Một đầu mối địa phương.\nMàu xanh cổ vịt – vàng – trắng; không xanh dương, không Cầu Rồng.\nKhông bịa khách hàng, case hoặc năng lực đã chứng minh.`
      },
      {
        id: 'HCMC_EVENTS',
        name: 'HCMC Events',
        type: 'Sự kiện',
        brand: 'HCMC Events',
        folder_rules: 'HCMC_EVENTS/RULES',
        folder_topics: 'HCMC_EVENTS/TOPICS',
        folder_materials: 'HCMC_EVENTS/MATERIALS',
        folder_output: 'HCMC_EVENTS/OUTPUT',
        time: '16:00',
        rule: `HCMC Events là thương hiệu độc lập tại TP.HCM.\nMàu đỏ – trắng.\nĐối tượng: Marketing Manager, HR/Admin, Procurement.\nNội dung cụ thể về nhu cầu và giải pháp; không tự thêm ưu đãi hoặc case.`
      }
    ];

    const now = new Date().toISOString();
    for (const p of defaultProfiles) {
      db.prepare(`
        INSERT INTO profiles (id, name, type, brand, folder_id_rules, folder_id_topics, folder_id_materials, folder_id_output, time, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(p.id, p.name, p.type, p.brand, p.folder_rules, p.folder_topics, p.folder_materials, p.folder_output, p.time, now, now);

      // Create initial rule version
      const hash = Buffer.from(p.rule).toString('base64').slice(0, 32);
      db.prepare(`
        INSERT INTO rule_versions (id, profile_id, version, content_markdown, hash, status, created_by, created_at)
        VALUES (?, ?, 1, ?, ?, 'published', 'u_admin', ?)
      `).run(`rv_${p.id}_1`, p.id, p.rule, hash, now);
    }
  }
}
