import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('profile persists the root Drive folder and provisioned child IDs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbg-profile-root-'));
  process.env.HBG_DATA_DIR = tempDir;
  let database = null;
  try {
    const { db, initDb } = await import('../src/db.js');
    const { createProfile } = await import('../src/models/profile.js');
    database = db;
    initDb();

    const profile = createProfile({
      id: 'prof_root_test',
      name: 'Root folder test',
      type: 'Test',
      folder_id_profile: 'root-folder-id',
      folder_id_rules: 'rules-folder-id',
      folder_id_topics: 'topics-folder-id',
      folder_id_output: 'output-folder-id',
      sheet_id_topics: 'spreadsheet-id',
      active: true
    });

    assert.equal(profile.folder_id_profile, 'root-folder-id');
    assert.equal(profile.folder_id_rules, 'rules-folder-id');
    assert.equal(profile.folder_id_topics, 'topics-folder-id');
    assert.equal(profile.folder_id_output, 'output-folder-id');
    assert.equal(profile.sheet_id_topics, 'spreadsheet-id');
  } finally {
    database?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
