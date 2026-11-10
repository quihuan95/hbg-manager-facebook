import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProfileRuleFiles } from '../src/google/profile-rule-files.js';

test('buildProfileRuleFiles creates the standard rule files for a profile', () => {
  const files = buildProfileRuleFiles({
    id: 'prof_tourist',
    name: 'HoaBinh Tourist',
    type: 'Tour Inbound / Outbound / Nội địa',
    active: 0,
    workflow_mode: 'semi_auto',
    timezone: 'Asia/Ho_Chi_Minh',
    language: 'vi',
    folder_id_rules: 'rules-folder-id',
    sheet_id_topics: 'sheet-id',
    folder_id_output: 'output-folder-id',
    time: '09:00'
  });

  assert.deepEqual(Object.keys(files), [
    'CONTENT_RULE.md',
    'BRAND_FACTS.md',
    'IMAGE_RULE.md',
    'PUBLISH_CONFIG.json'
  ]);
  const config = JSON.parse(files['PUBLISH_CONFIG.json']);
  assert.equal(config.profile_id, 'prof_tourist');
  assert.equal(config.profile_name, 'HoaBinh Tourist');
  assert.equal(config.rules_folder_url, 'rules-folder-id');
  assert.equal(config.topics_tab, 'TOPICS');
  assert.equal(config.enabled, false);
});
