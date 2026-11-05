import crypto from 'node:crypto';
import { db } from './db.js';

const ACTIVE_STATUSES = ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'];

function hydrateJob(job) {
  if (!job) return null;
  return {
    ...job,
    items: db.prepare(`
      SELECT id, job_id, topic_id, post_id, title, status, stage, progress,
             worker_number, error_message, created_at, updated_at, finished_at
      FROM automation_job_items WHERE job_id = ? ORDER BY created_at, id
    `).all(job.id)
  };
}

export function recoverInterruptedJobs() {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE posts SET status = 'DRAFT', updated_at = ?
    WHERE status = 'GENERATING' AND id IN (
      SELECT post_id FROM automation_job_items WHERE status IN ('QUEUED', 'RUNNING') AND post_id IS NOT NULL
    )
  `).run(now);
  db.prepare(`
    UPDATE automation_job_items
    SET status = 'CANCELLED', stage = 'CANCELLED', progress = 100,
        error_message = 'Tác vụ đã được hủy.', updated_at = ?, finished_at = ?
    WHERE status IN ('QUEUED', 'RUNNING')
      AND job_id IN (SELECT id FROM automation_jobs WHERE status = 'CANCEL_REQUESTED')
  `).run(now, now);
  db.prepare(`
    UPDATE automation_jobs
    SET status = 'CANCELLED', cancelled_items = total_items - completed_items - failed_items,
        updated_at = ?, finished_at = ?
    WHERE status = 'CANCEL_REQUESTED'
  `).run(now, now);
  db.prepare(`
    UPDATE automation_job_items
    SET status = 'FAILED', stage = 'INTERRUPTED', error_message = ?, updated_at = ?, finished_at = ?
    WHERE status IN ('QUEUED', 'RUNNING')
  `).run('Ứng dụng đã dừng trước khi tác vụ hoàn tất.', now, now);
  db.prepare(`
    UPDATE automation_jobs
    SET status = 'FAILED', failed_items = total_items, error_message = ?, updated_at = ?, finished_at = ?
    WHERE status IN ('QUEUED', 'RUNNING')
  `).run('Ứng dụng đã dừng trước khi tác vụ hoàn tất.', now, now);
}

export function createAutomationJob(topicIds) {
  const topics = db.prepare(`
    SELECT id, topic_title FROM topics
    WHERE id IN (${topicIds.map(() => '?').join(', ')})
  `).all(...topicIds);
  if (topics.length !== topicIds.length) throw new Error('Một hoặc nhiều lịch tạo bài không còn tồn tại.');
  const byId = new Map(topics.map(topic => [topic.id, topic]));
  const id = `job_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO automation_jobs (id, status, total_items, created_at, updated_at)
      VALUES (?, 'QUEUED', ?, ?, ?)
    `).run(id, topicIds.length, now, now);
    const insertItem = db.prepare(`
      INSERT INTO automation_job_items (id, job_id, topic_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    topicIds.forEach(topicId => insertItem.run(`jobitem_${crypto.randomUUID()}`, id, topicId, byId.get(topicId).topic_title, now, now));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getAutomationJob(id);
}

export function startAutomationJob(jobId, workerCount) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE automation_jobs SET status = 'RUNNING', worker_count = ?, started_at = ?, updated_at = ? WHERE id = ?
  `).run(workerCount, now, now, jobId);
}

export function updateAutomationJobItem(jobId, topicId, update = {}) {
  const now = new Date().toISOString();
  const terminal = ['COMPLETED', 'SKIPPED', 'CANCELLED', 'FAILED'].includes(update.status);
  db.prepare(`
    UPDATE automation_job_items
    SET post_id = COALESCE(?, post_id), status = COALESCE(?, status), stage = COALESCE(?, stage),
        progress = COALESCE(?, progress), worker_number = COALESCE(?, worker_number),
        error_message = ?, updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END
    WHERE job_id = ? AND topic_id = ?
  `).run(update.postId || null, update.status || null, update.stage || null,
    Number.isFinite(update.progress) ? Math.max(0, Math.min(100, update.progress)) : null,
    update.workerNumber || null, update.error || null, now, terminal ? 1 : 0, now, jobId, topicId);
  db.prepare(`
    UPDATE automation_jobs
    SET completed_items = (
          SELECT COUNT(*) FROM automation_job_items WHERE job_id = ? AND status IN ('COMPLETED', 'SKIPPED')
        ),
        failed_items = (
          SELECT COUNT(*) FROM automation_job_items WHERE job_id = ? AND status = 'FAILED'
        ),
        cancelled_items = (
          SELECT COUNT(*) FROM automation_job_items WHERE job_id = ? AND status = 'CANCELLED'
        ),
        updated_at = ?
    WHERE id = ?
  `).run(jobId, jobId, jobId, now, jobId);
}

export function requestAutomationJobCancellation(jobId) {
  const job = getAutomationJob(jobId);
  if (!job) return null;
  if (!ACTIVE_STATUSES.includes(job.status)) return job;
  const now = new Date().toISOString();
  db.prepare(`UPDATE automation_jobs SET status = 'CANCEL_REQUESTED', updated_at = ? WHERE id = ?`).run(now, jobId);
  db.prepare(`
    UPDATE automation_job_items
    SET status = 'CANCELLED', stage = 'CANCELLED', progress = 100,
        error_message = 'Đã hủy trước khi worker bắt đầu.', updated_at = ?, finished_at = ?
    WHERE job_id = ? AND status = 'QUEUED'
  `).run(now, now, jobId);
  return getAutomationJob(jobId);
}

export function isAutomationJobCancellationRequested(jobId) {
  return db.prepare('SELECT status FROM automation_jobs WHERE id = ?').get(jobId)?.status === 'CANCEL_REQUESTED';
}

export function finishAutomationJob(jobId, result = null, error = null) {
  const now = new Date().toISOString();
  const cancellationRequested = isAutomationJobCancellationRequested(jobId);
  const profileError = result?.profiles?.find(profile => profile.error)?.error;
  const unfinishedError = cancellationRequested ? 'Tác vụ đã được hủy.' : (error?.message || profileError || 'Tác vụ kết thúc trước khi bài được xử lý đầy đủ.');
  db.prepare(`
    UPDATE automation_job_items
    SET status = ?, stage = ?, progress = 100, error_message = ?, updated_at = ?, finished_at = ?
    WHERE job_id = ? AND status IN ('QUEUED', 'RUNNING')
  `).run(cancellationRequested ? 'CANCELLED' : 'FAILED', cancellationRequested ? 'CANCELLED' : 'FAILED', unfinishedError, now, now, jobId);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('COMPLETED', 'SKIPPED') THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
      , SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
    FROM automation_job_items WHERE job_id = ?
  `).get(jobId);
  const completed = Number(counts.completed || 0);
  const failed = Number(counts.failed || 0);
  const cancelled = Number(counts.cancelled || 0);
  const status = error ? 'FAILED'
    : failed > 0 ? (completed > 0 || cancelled > 0 ? 'PARTIAL' : 'FAILED')
      : cancelled > 0 ? (completed > 0 ? 'PARTIAL' : 'CANCELLED')
        : 'COMPLETED';
  db.prepare(`
    UPDATE automation_jobs
    SET status = ?, completed_items = ?, failed_items = ?, cancelled_items = ?, error_message = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `).run(status, completed, failed, cancelled, error?.message || null, now, now, jobId);
  return getAutomationJob(jobId);
}

export function getAutomationJob(id) {
  return hydrateJob(db.prepare('SELECT * FROM automation_jobs WHERE id = ?').get(id));
}

export function listAutomationJobs({ active = false, limit = 20 } = {}) {
  const rows = active
    ? db.prepare(`SELECT * FROM automation_jobs WHERE status IN (?, ?, ?) ORDER BY created_at DESC`).all(...ACTIVE_STATUSES)
    : db.prepare('SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(100, limit)));
  return rows.map(hydrateJob);
}
