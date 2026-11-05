import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('automation job persists progress, partial failure, and interrupted recovery', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbg-automation-job-'));
  process.env.HBG_DATA_DIR = tempDir;
  let database = null;
  try {
    const { db, initDb } = await import('../src/db.js');
    database = db;
    const {
      createAutomationJob,
      finishAutomationJob,
      getAutomationJob,
      recoverInterruptedJobs,
      requestAutomationJobCancellation,
      isAutomationJobCancellationRequested,
      startAutomationJob,
      updateAutomationJobItem
    } = await import('../src/automation-jobs.js');
    initDb();

    const now = new Date().toISOString();
    const insertTopic = db.prepare(`
      INSERT INTO topics (
        id, profile_id, topic_id, content_date, topic_title, status,
        source_hash, imported_at, publish_time
      ) VALUES (?, 'HBG_MICE', ?, '2026-11-05', ?, 'READY', ?, ?, '09:00')
    `);
    insertTopic.run('topic_test_1', 'TEST_1', 'Bài kiểm thử 1', 'hash_1', now);
    insertTopic.run('topic_test_2', 'TEST_2', 'Bài kiểm thử 2', 'hash_2', now);

    const created = createAutomationJob(['topic_test_1', 'topic_test_2']);
    assert.equal(created.status, 'QUEUED');
    assert.equal(created.total_items, 2);
    assert.equal(created.items.length, 2);

    startAutomationJob(created.id, 2);
    updateAutomationJobItem(created.id, 'topic_test_1', {
      status: 'RUNNING', stage: 'GENERATING_CAPTION', progress: 15, workerNumber: 1
    });
    updateAutomationJobItem(created.id, 'topic_test_2', {
      status: 'FAILED', stage: 'FAILED', progress: 100, workerNumber: 2, error: 'Lỗi kiểm thử'
    });
    updateAutomationJobItem(created.id, 'topic_test_1', {
      status: 'COMPLETED', stage: 'COMPLETED', progress: 100, workerNumber: 1, postId: 'post_test_1'
    });
    const finished = finishAutomationJob(created.id);
    assert.equal(finished.status, 'PARTIAL');
    assert.equal(finished.completed_items, 1);
    assert.equal(finished.failed_items, 1);
    assert.equal(finished.items.find(item => item.topic_id === 'topic_test_1').progress, 100);
    assert.equal(finished.items.find(item => item.topic_id === 'topic_test_2').error_message, 'Lỗi kiểm thử');

    const preparationFailure = createAutomationJob(['topic_test_2']);
    startAutomationJob(preparationFailure.id, 0);
    const failedBeforeWorker = finishAutomationJob(preparationFailure.id, {
      success: false,
      profiles: [{ error: 'Không đồng bộ được Sheet' }]
    });
    assert.equal(failedBeforeWorker.status, 'FAILED');
    assert.equal(failedBeforeWorker.failed_items, 1);
    assert.equal(failedBeforeWorker.items[0].progress, 100);
    assert.equal(failedBeforeWorker.items[0].error_message, 'Không đồng bộ được Sheet');

    const cancellable = createAutomationJob(['topic_test_1', 'topic_test_2']);
    startAutomationJob(cancellable.id, 2);
    updateAutomationJobItem(cancellable.id, 'topic_test_1', {
      status: 'RUNNING', stage: 'GENERATING_CAPTION', progress: 15, workerNumber: 1
    });
    const cancelRequested = requestAutomationJobCancellation(cancellable.id);
    assert.equal(cancelRequested.status, 'CANCEL_REQUESTED');
    assert.equal(isAutomationJobCancellationRequested(cancellable.id), true);
    assert.equal(cancelRequested.items.find(item => item.topic_id === 'topic_test_2').status, 'CANCELLED');
    const cancelled = finishAutomationJob(cancellable.id, { success: true, profiles: [] });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.cancelled_items, 2);
    assert.equal(cancelled.items.every(item => item.stage === 'CANCELLED'), true);

    const interrupted = createAutomationJob(['topic_test_1']);
    startAutomationJob(interrupted.id, 1);
    recoverInterruptedJobs();
    const recovered = getAutomationJob(interrupted.id);
    assert.equal(recovered.status, 'FAILED');
    assert.equal(recovered.items[0].stage, 'INTERRUPTED');
    assert.match(recovered.error_message, /dừng trước khi tác vụ hoàn tất/);
  } finally {
    database?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.HBG_DATA_DIR;
  }
});

test('worker pool scales with work and never exceeds five workers', async () => {
  const { getAutomationWorkerCount } = await import('../src/automation.js');
  assert.equal(getAutomationWorkerCount(0), 0);
  assert.equal(getAutomationWorkerCount(1), 1);
  assert.equal(getAutomationWorkerCount(2), 2);
  assert.equal(getAutomationWorkerCount(4), 4);
  assert.equal(getAutomationWorkerCount(5), 5);
  assert.equal(getAutomationWorkerCount(20), 5);
});
