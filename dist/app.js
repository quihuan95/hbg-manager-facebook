'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const labels = {
  DRAFT: 'Nháp',
  GENERATING: 'Đang tạo AI...',
  NEEDS_REVIEW: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  READY_FOR_MANUAL_UPLOAD: 'Chờ đăng thủ công',
  MANUALLY_UPLOADED: 'Đã đăng xong',
  ARCHIVED: 'Đã lưu trữ'
};

const routes = {
  create_posts: ['＋', 'Tạo bài'],
  created_posts: ['▤', 'Bài đã tạo'],
  publishing: ['↗', 'Quản lý đăng bài'],
  calendar: ['▦', 'Lịch nội dung'],
  profiles: ['◈', 'Content Profiles'],
  rules: ['≡', 'Quy tắc'],
  logs: ['⌁', 'Nhật ký hệ thống'],
  settings: ['⚙', 'Cài đặt & Kết nối']
};

let currentPostId = null;
let serverStatus = null;
let cachedProfiles = [];
let cachedPosts = [];
let filter = '';
let query = '';
let studioReturnRoute = 'created_posts';
let calendarMonth = new Date().toISOString().slice(0, 7);

function toast(t, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = t;
  el.style.display = 'block';
  el.style.background = isError ? '#8b0000' : '#142747';
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function goto(r) {
  location.hash = r;
  render();
}

function getRoute() {
  const route = location.hash.slice(1) || 'create_posts';
  return route === 'queue' ? 'create_posts' : route;
}

function badge(s) {
  const key = s || 'DRAFT';
  let cssClass = 'tag';
  if (key === 'NEEDS_REVIEW') cssClass += ' review';
  else if (key === 'APPROVED') cssClass += ' approved';
  else if (key === 'READY_FOR_MANUAL_UPLOAD') cssClass += ' scheduled';
  else if (key === 'MANUALLY_UPLOADED') cssClass += ' published';
  else if (key === 'GENERATING') cssClass += ' review';
  return `<span class="${cssClass}">${esc(labels[key] || key)}</span>`;
}

function mark(p) {
  if (!p) return '<span class="mark">HB</span>';
  return `<span class="mark ${p.id === 'DANANG_EVENTS' ? 'dne' : p.id === 'HCMC_EVENTS' ? 'hcmc' : ''}">${esc((p.name || 'HB').split(' ').map(x => x[0]).join('').slice(0, 2))}</span>`;
}

// API Fetch Helpers
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.statusText || 'Lỗi kết nối máy chủ');
  }
  return data;
}

async function fetchStatus() {
  try {
    serverStatus = await api('/api/status');
  } catch {
    serverStatus = null;
  }
}

async function fetchProfiles() {
  try {
    cachedProfiles = await api('/api/profiles');
  } catch (e) {
    console.error(e);
  }
}

async function render() {
  let r = getRoute();
  if (!serverStatus) await fetchStatus();
  if ($('#appVersion')) $('#appVersion').textContent = `v${serverStatus?.appVersion || '...'}`;
  if (!routes[r] && r !== 'studio') r = 'create_posts';
  $('#title').textContent = r === 'studio' ? 'AI Content Studio' : routes[r][1];
  const postRoutes = ['create_posts', 'created_posts', 'publishing'];
  const otherRoutes = Object.entries(routes).filter(([key]) => !postRoutes.includes(key));
  $('#nav').innerHTML = `
    <div class="nav-group ${postRoutes.includes(r) || r === 'studio' ? 'open' : ''}">
      <div class="nav-group-title"><i>▤</i><span>Quản lý bài</span></div>
      <div class="nav-children">
        ${postRoutes.map(k => `<a href="#${k}" class="${r === k ? 'active' : ''}"><i>${routes[k][0]}</i>${routes[k][1]}</a>`).join('')}
      </div>
    </div>
    ${otherRoutes.map(([k, v]) => `<a href="#${k}" class="${r === k ? 'active' : ''}"><i>${v[0]}</i>${v[1]}</a>`).join('')}
  `;
  const views = {
    create_posts: renderQueue,
    created_posts: renderQueue,
    publishing: renderQueue,
    calendar: renderCalendar,
    profiles: renderProfiles,
    rules: renderRules,
    logs: renderLogs,
    settings: renderSettings,
    studio: renderStudio
  };

  if (views[r]) {
    await views[r]();
  }
}

async function renderQueue() {
  const queueMode = getRoute();
  await fetchProfiles();
  let syncedTopics = [];
  try {
    [cachedPosts, syncedTopics] = await Promise.all([
      api('/api/posts'),
      api('/api/topics?all=true')
    ]);
  } catch {
    cachedPosts = [];
  }

  const publishingStatuses = ['APPROVED', 'READY_FOR_MANUAL_UPLOAD', 'MANUALLY_UPLOADED'];
  const statusOptions = Object.entries(labels).filter(([key]) => queueMode !== 'publishing' || publishingStatuses.includes(key));
  let jobs = cachedPosts.filter(j =>
    (queueMode !== 'publishing' || publishingStatuses.includes(j.status)) &&
    (!filter || j.status === filter) &&
    (!query || `${j.topic_title} ${j.profile_name || ''}`.toLowerCase().includes(query.toLowerCase()))
  );

  const readyCount = cachedPosts.filter(j => j.status === 'READY_FOR_MANUAL_UPLOAD').length;
  const reviewCount = cachedPosts.filter(j => j.status === 'NEEDS_REVIEW').length;
  const uploadedCount = cachedPosts.filter(j => j.status === 'MANUALLY_UPLOADED').length;

  $('#view').innerHTML = `
    <div class="stats" ${queueMode === 'publishing' ? '' : 'style="display:none"'}>
      ${[
        [cachedPosts.length, 'Tổng số bài viết', 'Lưu bền vững trong Database'],
        [reviewCount, 'Chờ duyệt nội dung', 'Cần kiểm tra caption và ảnh'],
        [readyCount, 'Chờ đăng thủ công', 'Đã xuất đủ bộ Drive'],
        [uploadedCount, 'Đã đăng hoàn tất', 'Đã lưu vết kiểm toán']
      ].map(x => `
        <div class="stat">
          <span>${x[1]}</span>
          <b>${x[0].toString().padStart(2, '0')}</b>
          <small>${x[2]}</small>
        </div>
      `).join('')}
    </div>

    <section class="panel queue-panel" ${queueMode === 'create_posts' ? '' : 'style="display:none"'}>
      <div class="panelhead queue-panelhead">
        <div>
          <h2>Tạo bài từ lịch đã đồng bộ <span class="pill">/ ${syncedTopics.length} lịch</span></h2>
          <p class="muted">Chọn các lịch trong Sheet rồi chạy tạo caption, ảnh và bộ OUTPUT.</p>
        </div>
        <div class="toolbar">
          <button id="generateSelected" class="primary">⚡ Tạo bài đã chọn</button>
          <button id="syncAllFromCreate">📥 Đồng bộ tất cả Sheet</button>
        </div>
      </div>
      <div class="tablewrap">
        <table class="queue-table topic-queue-table">
          <thead><tr><th><input type="checkbox" id="selectAllTopics" aria-label="Chọn tất cả lịch có thể tạo"></th><th>CHỦ ĐỀ TỪ SHEET</th><th>PROFILE</th><th>LỊCH ĐĂNG</th><th>TRẠNG THÁI</th><th>THAO TÁC</th></tr></thead>
          <tbody>
            ${syncedTopics.map(t => {
              const finished = ['READY_FOR_MANUAL_UPLOAD', 'MANUALLY_UPLOADED'].includes(t.post_status);
              const hasSchedule = /^\d{4}-\d{2}-\d{2}$/.test(t.content_date || '') && Boolean(t.publish_time);
              const canGenerate = t.status !== 'DISABLED' && hasSchedule && !finished;
              const canCreateOne = t.status !== 'DISABLED' && !finished;
              const availability = !hasSchedule
                ? ' · Thiếu ngày/giờ'
                : (t.status === 'HOLD' ? ' · Có thể tạo thủ công' : '');
              return `<tr>
                <td><input type="checkbox" data-topic-select value="${esc(t.id)}" ${canGenerate ? '' : 'disabled'} aria-label="Chọn ${esc(t.topic_title)}"></td>
                <td><div class="topic">${esc(t.topic_title)}</div><small>${esc(t.topic_id)} · Sheet: ${esc(t.status)}${esc(availability)}</small></td>
                <td class="profile-cell">${esc(t.profile_name || t.profile_id)}</td>
                <td class="schedule-cell">${esc(t.content_date || 'Chưa có ngày')} <small>${esc(t.publish_time || 'Chưa có giờ')} · GMT+7</small></td>
                <td class="status-cell">${t.post_id ? badge(t.post_status) : '<span class="tag">Chưa tạo</span>'}</td>
                <td><div class="row-actions">${finished
                  ? `<button data-open="${esc(t.post_id)}">Mở bài</button>`
                  : `<button data-create-topic="${esc(t.id)}" ${canCreateOne ? '' : 'disabled'} class="primary">⚡ Tạo bài</button>`}
                  <button data-delete-topic="${esc(t.id)}" class="icon-button" title="Xóa lịch khỏi tool" aria-label="Xóa lịch">🗑</button></div>
                </td>
              </tr>`;
            }).join('') || '<tr><td colspan="6" class="empty">Chưa có lịch từ Sheet. Hãy bấm <b>Đồng bộ tất cả Sheet</b>.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel" ${queueMode === 'create_posts' ? 'style="display:none"' : ''}>
      <div class="panelhead">
        <h2>${queueMode === 'publishing' ? 'Quản lý đăng bài' : 'Danh sách bài đã tạo'} <span class="pill">/ ${jobs.length} bài viết</span></h2>
        <div class="toolbar">
          <button id="publishSelectedPosts" class="primary" ${queueMode === 'publishing' ? '' : 'style="display:none"'}>Đăng bài đã chọn</button>
          <button id="deleteSelectedPosts" ${queueMode === 'created_posts' ? '' : 'style="display:none"'}>🗑 Xóa bài đã chọn</button>
          <input id="search" type="search" placeholder="Tìm chủ đề hoặc thương hiệu..." value="${esc(query)}">
          <select id="filter">
            <option value="">${queueMode === 'publishing' ? 'Tất cả trạng thái đăng' : 'Tất cả trạng thái'}</option>
            ${statusOptions.map(([k, v]) => `<option value="${k}" ${filter === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" id="selectAllPosts" aria-label="Chọn tất cả bài"></th>
              <th>CHỦ ĐỀ BÀI VIẾT</th>
              <th>PROFILE / THƯƠNG HIỆU</th>
              <th>NGÀY & GIỜ</th>
              <th>TRẠNG THÁI</th>
              <th>THAO TÁC</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.map(j => {
              const p = cachedProfiles.find(x => x.id === j.profile_id);
              return `
                <tr>
                  <td><input type="checkbox" data-post-select value="${esc(j.id)}" aria-label="Chọn ${esc(j.topic_title)}"></td>
                  <td>
                    <div class="topic">${esc(j.topic_title)}</div>
                    <small>Revision ${j.revision_number || 1} · ${j.headline ? esc(j.headline.slice(0, 40)) + '...' : 'Chưa có headline'}</small>
                  </td>
                  <td>
                    <div class="brandline">
                      ${mark(p)}
                      <div>${esc(j.profile_name)} <small>${esc(j.profile_type || '')}</small></div>
                    </div>
                  </td>
                  <td>${esc(j.content_date)} <small>${esc(j.scheduled_time || '09:00')} · GMT+7</small></td>
                  <td>${badge(j.status)}</td>
                  <td>
                    ${['READY_FOR_MANUAL_UPLOAD', 'APPROVED'].includes(j.status)
                      ? `<button data-publish="${j.id}" class="primary">Đăng bài</button>`
                      : j.status === 'MANUALLY_UPLOADED'
                        ? `<button data-publish="${j.id}" style="border:1px solid #1877f2;color:#1877f2;background:#f0f7ff;font-weight:600">↻ Đăng lại</button>`
                        : ''}
                    <button data-open="${j.id}" class="${j.status === 'READY_FOR_MANUAL_UPLOAD' ? 'primary' : ''}">
                      ${j.status === 'READY_FOR_MANUAL_UPLOAD' ? '📋 Xem & Đăng' : 'Mở Studio'}
                    </button>
                    <button data-delete="${j.id}" title="Xóa bài">🗑</button>
                  </td>
                </tr>
              `;
            }).join('') || '<tr><td colspan="6" class="empty">Chưa có bài viết. Chọn lịch ở bảng phía trên rồi bấm <b>Tạo bài đã chọn</b>.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;

  $('#filter').onchange = e => { filter = e.target.value; renderQueue(); };
  $('#search').oninput = e => {
    query = e.target.value;
    const pos = e.target.selectionStart;
    renderQueue();
    $('#search').focus();
    $('#search').setSelectionRange(pos, pos);
  };

  $('#selectAllTopics').onchange = e => {
    document.querySelectorAll('[data-topic-select]:not(:disabled)').forEach(input => { input.checked = e.target.checked; });
  };
  $('#generateSelected').onclick = e => {
    const topicIds = [...document.querySelectorAll('[data-topic-select]:checked')].map(input => input.value);
    if (!topicIds.length) return toast('Hãy chọn ít nhất một lịch từ Sheet.', true);
    runAutomation(e.currentTarget, topicIds);
  };
  $('#syncAllFromCreate').onclick = e => syncAllProfiles(e.currentTarget, renderQueue);

  document.querySelectorAll('[data-create-topic]').forEach(button => {
    button.onclick = () => {
      const topic = syncedTopics.find(item => item.id === button.dataset.createTopic);
      if (!topic) return;
      const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(topic.content_date || '');
      const hasTime = Boolean(topic.publish_time);
      if (hasDate && hasTime) {
        runAutomation(button, [topic.id]);
        return;
      }
      modal(`Chọn lịch đăng · ${topic.topic_title}`, `
        <p class="muted">Bản ghi Sheet đang thiếu ngày hoặc giờ. Chọn lịch để tạo riêng bài này.</p>
        <div class="formrow">
          <label>Ngày đăng<input type="date" name="date" required value="${esc(topic.content_date || new Date().toISOString().slice(0, 10))}"></label>
          <label>Giờ đăng<input type="time" name="time" required value="${esc(topic.publish_time || '09:00')}"></label>
        </div>
      `, f => {
        runAutomation(null, [topic.id], {
          [topic.id]: { date: f.get('date'), time: f.get('time') }
        });
      });
    };
  });

  document.querySelectorAll('[data-delete-topic]').forEach(button => {
    button.onclick = async () => {
      const topic = syncedTopics.find(item => item.id === button.dataset.deleteTopic);
      const hasPost = Boolean(topic?.post_id);
      const warning = hasPost
        ? ' Bài viết đã tạo sẽ được giữ nguyên.'
        : '';
      if (!confirm(`Xóa lịch “${topic?.topic_title || button.dataset.deleteTopic}” khỏi tool?${warning}\n\nNếu dòng này vẫn còn trong Sheet, nó sẽ xuất hiện lại ở lần đồng bộ sau.`)) return;
      try {
        const result = await api(`/api/topics/${encodeURIComponent(button.dataset.deleteTopic)}`, { method: 'DELETE' });
        toast(result.preservedPosts
          ? `Đã xóa lịch khỏi tool và giữ nguyên ${result.preservedPosts} bài đã tạo.`
          : 'Đã xóa lịch khỏi tool.');
        await renderQueue();
      } catch (err) {
        toast(`Lỗi xóa lịch: ${err.message}`, true);
      }
    };
  });

  $('#selectAllPosts').onchange = e => {
    document.querySelectorAll('[data-post-select]').forEach(input => { input.checked = e.target.checked; });
  };
  $('#publishSelectedPosts').onclick = () => {
    const selectedIds = [...document.querySelectorAll('[data-post-select]:checked')].map(input => input.value);
    if (!selectedIds.length) return toast('Hãy chọn ít nhất một bài để đăng.', true);

    const eligibleIds = selectedIds.filter(id => {
      const post = cachedPosts.find(item => item.id === id);
      return post && ['READY_FOR_MANUAL_UPLOAD', 'APPROVED', 'MANUALLY_UPLOADED'].includes(post.status);
    });
    const skippedCount = selectedIds.length - eligibleIds.length;
    if (!eligibleIds.length) return toast('Các bài đã chọn chưa được duyệt hoặc chưa sẵn sàng đăng.', true);

    modal(`Xác nhận đăng ${eligibleIds.length} bài`, `
      <p class="muted">Xác nhận bạn đã đăng thủ công ${eligibleIds.length} bài lên Facebook.${skippedCount ? ` Có ${skippedCount} bài chưa sẵn sàng sẽ được bỏ qua.` : ''}</p>
      <label>Ghi chú chung (tùy chọn)
        <input name="note" placeholder="Ví dụ: Đăng theo chiến dịch tháng này">
      </label>
    `, async f => {
      try {
        const result = await api('/api/posts/bulk-mark-manually-uploaded', {
          method: 'POST',
          body: JSON.stringify({ postIds: eligibleIds, note: f.get('note') })
        });
        const skippedMessage = result.skipped.length ? ` Bỏ qua ${result.skipped.length} bài.` : '';
        toast(`Đã đăng ${result.published.length} bài.${skippedMessage}`);
        await renderQueue();
      } catch (err) {
        toast(`Lỗi đăng hàng loạt: ${err.message}`, true);
        return false;
      }
    });
  };
  $('#deleteSelectedPosts').onclick = async () => {
    const postIds = [...document.querySelectorAll('[data-post-select]:checked')].map(input => input.value);
    if (!postIds.length) return toast('Hãy chọn ít nhất một bài để xóa.', true);
    if (!confirm(`Xóa ${postIds.length} bài đã chọn? Dữ liệu revision, duyệt và export liên quan cũng sẽ bị xóa.`)) return;
    try {
      await Promise.all(postIds.map(id => api(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' })));
      toast(`Đã xóa ${postIds.length} bài.`);
      await renderQueue();
    } catch (err) {
      toast(`Lỗi xóa bài: ${err.message}`, true);
    }
  };

  document.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => {
      currentPostId = b.dataset.open;
      studioReturnRoute = queueMode === 'publishing' ? 'publishing' : 'created_posts';
      goto('studio');
    };
  });
  document.querySelectorAll('[data-publish]').forEach(button => {
    button.onclick = () => {
      const post = cachedPosts.find(item => item.id === button.dataset.publish);
      if (!post) return;
      const isRePublish = post.status === 'MANUALLY_UPLOADED';
      modal(isRePublish ? 'Đăng lại bài lên Facebook' : 'Đăng bài lên Facebook', `
        <p class="muted">
          ${isRePublish ? '<span style="display:inline-block;padding:4px 8px;border-radius:4px;background:#fef3c7;color:#b45309;font-weight:600;font-size:12px;margin-bottom:8px">⚠️ Bài viết này đã được đăng trước đó</span><br>' : ''}
          ${isRePublish ? 'Bạn có muốn đăng lại bài' : 'Đăng bài'} <b>${esc(post.topic_title)}</b> lên Fanpage?
        </p>
        <label>Facebook Page đích (để trống sẽ dùng Page theo Token hoặc Profile)
          <input name="pageTarget" value="${esc(post.facebook_page_id || '')}" placeholder="1356722127527894 hoặc link Page">
        </label>
        <label>Phương thức đăng
          <select name="publishMethod" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--line);margin-top:5px">
            <option value="auto">🚀 Tự động đăng qua Meta Graph API (Khuyên dùng)</option>
            <option value="manual">${isRePublish ? 'Xác nhận đã đăng lại thủ công' : 'Đã đăng thủ công trên Facebook (Ghi nhận)'}</option>
          </select>
        </label>
        <label>Ghi chú (tùy chọn)
          <input name="note" placeholder="Ví dụ: Đăng lại bài">
        </label>
      `, async f => {
        const method = f.get('publishMethod');
        const pageTarget = f.get('pageTarget');
        const note = f.get('note');
        try {
          if (method === 'auto') {
            const res = await api(`/api/posts/${encodeURIComponent(post.id)}/publish-facebook`, {
              method: 'POST',
              body: JSON.stringify({ pageTarget, note })
            });
            toast(res.message || 'Đã đăng bài thành công lên Facebook!');
          } else {
            await api(`/api/posts/${encodeURIComponent(post.id)}/mark-manually-uploaded`, {
              method: 'POST',
              body: JSON.stringify({ pageTarget, note })
            });
            toast('Đã ghi nhận đăng bài thành công!');
          }
          await renderQueue();
        } catch (err) {
          toast(`Lỗi đăng bài: ${err.message}`, true);
          return false;
        }
      });
    };
  });
  document.querySelectorAll('[data-delete]').forEach(b => {
    b.onclick = async () => {
      const post = cachedPosts.find(item => item.id === b.dataset.delete);
      if (!confirm(`Xóa bài “${post?.topic_title || b.dataset.delete}”?`)) return;
      try {
        await api(`/api/posts/${encodeURIComponent(b.dataset.delete)}`, { method: 'DELETE' });
        toast('Đã xóa bài khỏi danh sách.');
        await renderQueue();
      } catch (err) {
        toast(`Lỗi xóa bài: ${err.message}`, true);
      }
    };
  });
}

function modal(title, body, fn) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalForm').onsubmit = async e => {
    e.preventDefault();
    if ((await fn(new FormData(e.target))) !== false) $('#modal').close();
  };
  $('#modal').showModal();
}

async function newJob() {
  await fetchProfiles();
  let syncedTopics = [];
  try {
    syncedTopics = await api('/api/topics');
  } catch {}

  const activeProfiles = cachedProfiles.filter(p => p.active);
  const defaultProfId = activeProfiles[0]?.id || '';

  const topicsForDefault = syncedTopics.filter(t => t.profile_id === defaultProfId);

  modal('Tạo bài viết mới', `
    <label>Content Profile (Thương hiệu)
      <select name="profileId" id="newJobProfile">
        ${activeProfiles.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.type)})</option>`).join('')}
      </select>
    </label>

    ${syncedTopics.length > 0 ? `
      <label>Hoặc chọn chủ đề đã đồng bộ từ Google Drive (tab TOPICS)
        <select id="syncedTopicSelect">
          <option value="">-- Tự nhập chủ đề mới bên dưới --</option>
          ${syncedTopics.map(t => `<option value="${t.id}" data-prof="${t.profile_id}" data-title="${esc(t.topic_title)}" data-date="${esc(t.content_date)}" data-time="${esc(t.publish_time || '09:00')}">[${esc(t.profile_id)}] ${esc(t.content_date)} - ${esc(t.topic_title)}</option>`).join('')}
        </select>
      </label>
    ` : `
      <div style="background:#f0f4fc;padding:8px 12px;border-radius:6px;font-size:12px;color:#285de5;margin-bottom:12px">
        💡 <b>Mẹo:</b> Vào mục <b>Content Profiles</b> $\\rightarrow$ Bấm <b>Đồng bộ Sheet</b> để tự động tải danh sách chủ đề từ Google Drive vào đây.
      </div>
    `}

    <label>Chủ đề bài viết
      <input name="topic" id="newJobTopic" required maxlength="240" placeholder="Ví dụ: Hội nghị khách hàng cuối năm nhiều điểm cầu">
    </label>
    <div class="formrow">
      <label>Ngày nội dung<input type="date" name="date" id="newJobDate" required value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>Giờ đăng dự kiến<input type="time" name="time" id="newJobTime" value="09:00" required></label>
    </div>
  `, async f => {
    try {
      const created = await api('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          profileId: f.get('profileId'),
          topic: f.get('topic').trim(),
          date: f.get('date'),
          time: f.get('time')
        })
      });
      toast('Tạo bài viết thành công!');
      currentPostId = created.id;
      goto('studio');
    } catch (err) {
      toast(`Lỗi: ${err.message}`, true);
      return false;
    }
  });

  // Auto-fill when selecting a synced topic
  const sel = $('#syncedTopicSelect');
  if (sel) {
    sel.onchange = () => {
      const opt = sel.selectedOptions[0];
      if (opt && opt.value) {
        if (opt.dataset.prof) $('#newJobProfile').value = opt.dataset.prof;
        if (opt.dataset.title) $('#newJobTopic').value = opt.dataset.title;
        if (opt.dataset.date) $('#newJobDate').value = opt.dataset.date;
        if (opt.dataset.time) $('#newJobTime').value = opt.dataset.time;
      }
    };
  }
}

async function runAutomation(button, topicIds = null, scheduleOverrides = {}) {
  const originalText = button?.textContent || '⚡ Tạo bài tự động';
  if (button) {
    button.disabled = true;
    button.textContent = '⏳ Đang đọc Sheet và tạo bài...';
  }
  try {
    const result = await api('/api/automation/run', {
      method: 'POST',
      body: JSON.stringify({ topicIds, scheduleOverrides })
    });
    const s = result.summary || {};
    const errorCount = (s.failed || 0) + (s.profileErrors || 0);
    toast(`Tự động hoàn tất · Xuất: ${s.exported || 0} · Bỏ qua: ${s.skipped || 0} · Lỗi: ${errorCount}`,
      !result.success);
    await renderQueue();
  } catch (err) {
    toast(`Lỗi chạy tự động: ${err.message}`, true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function syncAllProfiles(button, onDone = null) {
  const originalText = button?.textContent || '📥 Đồng bộ tất cả';
  if (button) {
    button.disabled = true;
    button.textContent = '⏳ Đang đồng bộ tất cả...';
  }
  try {
    const result = await api('/api/profiles/sync-all', { method: 'POST' });
    const summary = result.summary || {};
    toast(`Đồng bộ ${summary.succeeded || 0}/${summary.profiles || 0} profile · Thêm: ${summary.imported || 0} · Cập nhật: ${summary.updated || 0}`, !result.success);
    if (onDone) await onDone();
  } catch (err) {
    toast(`Lỗi đồng bộ tất cả: ${err.message}`, true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function renderStudio() {
  if (!currentPostId) {
    goto('created_posts');
    return;
  }

  let post;
  try {
    post = await api(`/api/posts/${currentPostId}`);
  } catch (err) {
    toast(`Không tải được bài viết: ${err.message}`, true);
    goto('created_posts');
    return;
  }

  let findings = [];
  try {
    findings = JSON.parse(post.validation_findings_json || '[]');
  } catch {}

  let changeRequestReason = '';
  try {
    changeRequestReason = JSON.parse(post.change_request_details_json || '{}').reason || '';
  } catch {}

  const isReadyForManual = (post.status === 'READY_FOR_MANUAL_UPLOAD');
  const isUploaded = (post.status === 'MANUALLY_UPLOADED');
  const canPublish = post.status === 'APPROVED' || isReadyForManual;

  $('#view').innerHTML = `
    <button class="back" id="back">‹ Quay lại Tạo bài</button>

    ${isReadyForManual ? `
      <div class="notice" style="background:#eaf8ef;border-color:#bce5ca;color:#185a31">
        <strong>✅ Bộ bài đã được xuất an toàn lên Google Drive!</strong>
        Bài viết đang sẵn sàng để người vận hành sao chép caption, tải ảnh và đăng lên Fanpage.
      </div>
    ` : ''}

    <div class="studio-title">
      <h2>${esc(post.topic_title)}</h2>
      <p class="muted">Thương hiệu: <b>${esc(post.profile_name)}</b> · Ngày: ${esc(post.content_date)} ${esc(post.scheduled_time)} · ${badge(post.status)}</p>
    </div>

    ${post.status === 'DRAFT' && changeRequestReason ? `
      <div class="notice change-request-notice">
        <strong>Yêu cầu sửa lại</strong>
        <div class="change-request-reason">${esc(changeRequestReason)}</div>
        <small>Người yêu cầu: ${esc(post.change_requested_by || 'Không xác định')} · ${post.change_requested_at ? new Date(post.change_requested_at).toLocaleString('vi-VN') : ''}</small>
      </div>
    ` : ''}

    ${canPublish || isUploaded ? `
      <section class="panel" style="border: 2px solid #367260; background:#fbfdfc">
        <div class="panelhead">
          <h2>🚀 Vận hành Đăng bài (Publishing Studio)</h2>
          <span class="tag published">${isUploaded ? 'Đã hoàn tất đăng' : 'Sẵn sàng đăng'}</span>
        </div>
        <div class="actions">
          <button id="autoPublishFb" class="primary" style="background:#1877f2;border-color:#1877f2;color:white">
            ${isUploaded ? '↻ Đăng lại lên Facebook' : '🚀 Tự động đăng lên Facebook'}
          </button>
          <button id="copyCaption">📋 Sao chép toàn bộ Caption</button>
          ${post.image_data ? `<button id="downloadImage">📥 Tải ảnh Final</button>` : ''}
          ${post.drive_folder_id ? `<a href="https://drive.google.com/drive/folders/${esc(post.drive_folder_id)}" target="_blank" class="button" style="padding:10px 16px;text-decoration:none;border:1px solid var(--line);border-radius:8px;background:white;color:#273957;font-weight:600">📁 Mở thư mục bài trên Drive</a>` : ''}
          <button id="markUploaded">${isUploaded ? 'Đánh dấu đã đăng lại thủ công' : 'Đánh dấu đã đăng thủ công'}</button>
          ${isUploaded ? `
            <div style="font-size:14px;color:#2b6b52;padding:10px 0;width:100%">
              Đã đăng lúc: <b>${new Date(post.manually_uploaded_at).toLocaleString('vi-VN')}</b>
              ${post.manual_post_url ? ` · <a href="${esc(post.manual_post_url)}" target="_blank" style="color:#1877f2;text-decoration:underline;font-weight:600">Xem bài viết trên Facebook ↗</a>` : ''}
              ${post.manual_target_page ? ` · Page đích: <b>${esc(post.manual_target_page)}</b>` : ''}
            </div>
          ` : ''}
        </div>
      </section>
    ` : ''}

    <div class="layout">
      <div>
        <section class="panel">
          <div class="panelhead">
            <h2>Nội dung Caption</h2>
            <span class="pill">Revision ${post.revision_number} (${post.revision_id})</span>
          </div>
          <label>Tiêu đề nổi bật (Headline)
            <input id="headline" value="${esc(post.headline || '')}" placeholder="Tiêu đề bài viết...">
          </label>
          <label>Nội dung Caption
            <textarea id="caption" rows="12" placeholder="Nhấn nút ✨ AI Viết Caption hoặc nhập nội dung...">${esc(post.caption || '')}</textarea>
          </label>
          <label>Kêu gọi hành động (CTA)
            <input id="cta" value="${esc(post.cta || '')}" placeholder="Ví dụ: Nhắn tin hoặc gọi hotline để nhận tư vấn chi tiết.">
          </label>

          <div class="actions">
            <button id="aiCaption" class="primary">✨ Sinh Caption bằng AI (OpenAI)</button>
            ${post.status === 'DRAFT' && changeRequestReason ? `<button id="regenerateCaption">↻ Sinh lại theo yêu cầu sửa</button>` : ''}
            <button id="saveCaption">Lưu chỉnh sửa Revision</button>
          </div>
          <p class="muted" id="aiCaptionStatus">Tự động áp dụng Rule thương hiệu của <b>${esc(post.profile_name)}</b>.</p>
        </section>

        <section class="panel">
          <h2>Hình ảnh bài viết</h2>
          <div class="sectionlabel">BẢN XEM TRƯỚC (FINAL PREVIEW)</div>
          ${post.image_data ? `
            <img class="previewimg" src="${esc(post.image_data)}" alt="Ảnh bài viết">
          ` : `
            <div class="placeholder">
              <strong>Chưa có hình ảnh</strong>
              <span>Bấm nút <b>✨ Sinh ảnh bằng DALL-E</b> hoặc tải ảnh từ máy tính.</span>
            </div>
          `}

          <div class="actions" style="margin: 16px 0 10px;">
            <button id="aiImage" class="primary">✨ Sinh ảnh bằng DALL-E (AI)</button>
          </div>
          <p class="muted" id="aiImageStatus"></p>

          <label>Hoặc tải ảnh hoàn chỉnh từ máy (PNG/JPEG/WebP)
            <input id="imageFile" type="file" accept="image/png,image/jpeg,image/webp">
          </label>
        </section>
      </div>

      <div>
        <section class="panel">
          <h2>Phê duyệt & Xuất bản</h2>

          <div class="actions">
            <button class="primary" id="approveBtn" ${post.status === 'APPROVED' || isReadyForManual ? 'disabled' : ''}>
              ${post.status === 'APPROVED' || isReadyForManual ? '✓ Đã phê duyệt' : 'Phê duyệt bản này (Approve)'}
            </button>
            <button id="requestChangesBtn">Yêu cầu sửa lại</button>
          </div>

          ${post.status === 'APPROVED' ? `
            <div style="margin-top:20px;padding-top:15px;border-top:1px solid var(--line)">
              <p style="font-size:14px;color:#285de5;font-weight:600">Đã duyệt! Hãy xuất bộ bài lên Google Drive:</p>
              <button id="exportDriveBtn" class="primary" style="width:100%;margin-top:6px;background:#188038;border-color:#188038">
                📤 Xuất 4 tệp lên Google Drive (OUTPUT)
              </button>
              <p class="muted" id="exportStatus" style="font-size:12px;margin-top:6px">Gồm: caption.md, image.png, post.json, REVIEW.md</p>
            </div>
          ` : ''}
        </section>

        <section class="panel">
          <h2>Thông tin nguồn & Phiên bản</h2>
          <div class="details">
            <span>Thương hiệu</span><b>${esc(post.profile_name)}</b>
            <span>Thư mục Drive</span><b>${esc(post.folder_id_output || 'Chưa cấu hình')}</b>
            <span>Rule Hash</span><b>${esc((post.rule_hash || 'N/A').slice(0, 16))}...</b>
            <span>Revision Hash</span><b>${esc((post.revision_hash || 'N/A').slice(0, 16))}...</b>
            <span>Người duyệt</span><b>${esc(post.approver_id || 'Chưa duyệt')}</b>
          </div>
        </section>
      </div>
    </div>
  `;

  $('#back').onclick = () => goto(studioReturnRoute);

  // AI Caption
  $('#aiCaption').onclick = async () => {
    const btn = $('#aiCaption');
    btn.disabled = true;
    btn.textContent = '⏳ Đang viết caption với GPT...';
    try {
      const res = await api(`/api/posts/${post.id}/generate-caption`, { method: 'POST' });
      toast('Đã tạo caption mới bằng AI thành công!');
      renderStudio();
    } catch (err) {
      toast(`Lỗi tạo caption: ${err.message}`, true);
      btn.disabled = false;
      btn.textContent = '✨ Sinh Caption bằng AI (OpenAI)';
    }
  };

  // Regenerate caption using the latest change-request reason as prompt context
  const regenerateCaptionBtn = $('#regenerateCaption');
  if (regenerateCaptionBtn) {
    regenerateCaptionBtn.onclick = () => {
      modal('Sinh lại nội dung theo yêu cầu sửa', `
        <p class="muted">Lý do sửa gần nhất đã được điền sẵn. Bạn có thể bổ sung yêu cầu cụ thể trước khi gửi cho AI.</p>
        <label>Prompt chỉnh sửa
          <textarea name="promptContext" rows="7" required minlength="3">${esc(changeRequestReason)}</textarea>
        </label>
      `, async f => {
        const promptContext = String(f.get('promptContext') || '').trim();
        const revisionPrompt = `YÊU CẦU CHỈNH SỬA:\n${promptContext}\n\nNỘI DUNG HIỆN TẠI CẦN VIẾT LẠI:\nHeadline: ${post.headline || ''}\nCaption: ${post.caption || ''}\nCTA: ${post.cta || ''}`;
        try {
          regenerateCaptionBtn.disabled = true;
          regenerateCaptionBtn.textContent = '⏳ Đang sinh lại nội dung...';
          await api(`/api/posts/${post.id}/generate-caption`, {
            method: 'POST',
            body: JSON.stringify({ promptContext: revisionPrompt })
          });
          toast('Đã sinh lại nội dung theo yêu cầu sửa và tạo revision mới!');
          renderStudio();
        } catch (err) {
          toast(`Lỗi sinh lại nội dung: ${err.message}`, true);
          regenerateCaptionBtn.disabled = false;
          regenerateCaptionBtn.textContent = '↻ Sinh lại theo yêu cầu sửa';
          return false;
        }
      });
    };
  }

  // AI Image
  $('#aiImage').onclick = async () => {
    const btn = $('#aiImage');
    btn.disabled = true;
    btn.textContent = '⏳ Đang vẽ ảnh với DALL-E (10-15s)...';
    try {
      const res = await api(`/api/posts/${post.id}/generate-image`, { method: 'POST' });
      toast('Đã tạo ảnh mới bằng DALL-E thành công!');
      renderStudio();
    } catch (err) {
      toast(`Lỗi tạo ảnh: ${err.message}`, true);
      btn.disabled = false;
      btn.textContent = '✨ Sinh ảnh bằng DALL-E (AI)';
    }
  };

  // Save manual edits
  $('#saveCaption').onclick = async () => {
    try {
      await api(`/api/posts/${post.id}/revisions`, {
        method: 'PATCH',
        body: JSON.stringify({
          headline: $('#headline').value,
          caption: $('#caption').value,
          cta: $('#cta').value,
          expectedRevisionId: post.revision_id
        })
      });
      toast('Đã lưu revision mới thành công!');
      renderStudio();
    } catch (err) {
      toast(`Lỗi lưu revision: ${err.message}`, true);
    }
  };

  // Upload custom image
  $('#imageFile').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast('File ảnh không được vượt quá 15 MB', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api(`/api/posts/${post.id}/revisions`, {
          method: 'PATCH',
          body: JSON.stringify({
            imageData: reader.result,
            imageMime: file.type,
            expectedRevisionId: post.revision_id
          })
        });
        toast('Đã tải ảnh lên thành công!');
        renderStudio();
      } catch (err) {
        toast(`Lỗi tải ảnh: ${err.message}`, true);
      }
    };
    reader.readAsDataURL(file);
  };

  // Approve
  $('#approveBtn').onclick = async () => {
    try {
      await api(`/api/posts/${post.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approverId: 'u_admin' })
      });
      toast('Phê duyệt bài viết thành công!');
      renderStudio();
    } catch (err) {
      toast(`Lỗi duyệt bài: ${err.message}`, true);
    }
  };

  // Request changes
  $('#requestChangesBtn').onclick = async () => {
    modal('Yêu cầu sửa lại bài viết', `
      <p class="muted">Mô tả rõ nội dung cần chỉnh sửa để người biên tập có thể xử lý chính xác.</p>
      <label>Lý do cần sửa
        <textarea name="reason" rows="5" required minlength="3" placeholder="Ví dụ: Điều chỉnh CTA, bỏ thông tin giá và đổi hình ảnh phù hợp thương hiệu."></textarea>
      </label>
    `, async f => {
      try {
        await api(`/api/posts/${post.id}/request-changes`, {
          method: 'POST',
          body: JSON.stringify({ reason: f.get('reason') })
        });
        toast('Đã chuyển bài về trạng thái Nháp để sửa đổi.');
        renderStudio();
      } catch (err) {
        toast(`Lỗi: ${err.message}`, true);
        return false;
      }
    });
  };

  // Export to Drive
  const exportBtn = $('#exportDriveBtn');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = '⏳ Đang tải 4 tệp lên Google Drive...';
      try {
        const res = await api(`/api/posts/${post.id}/export`, { method: 'POST' });
        toast('Đã xuất bộ bài lên Google Drive thành công!');
        renderStudio();
      } catch (err) {
        toast(`Lỗi xuất Drive: ${err.message}`, true);
        exportBtn.disabled = false;
        exportBtn.textContent = '📤 Xuất 4 tệp lên Google Drive (OUTPUT)';
      }
    };
  }

  // Copy caption
  const copyBtn = $('#copyCaption');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const fullText = `${post.headline || ''}\n\n${post.caption}\n\n${post.cta ? `${post.cta}` : ''}`.trim();
      navigator.clipboard.writeText(fullText).then(() => {
        toast('Đã sao chép caption vào bộ nhớ tạm!');
      }).catch(() => {
        toast('Không sao chép được, hãy bôi đen text để copy.', true);
      });
    };
  }

  // Download image
  const downloadBtn = $('#downloadImage');
  if (downloadBtn && post.image_data) {
    downloadBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = post.image_data;
      a.download = `post_${post.id}_image.png`;
      a.click();
    };
  }

  // Auto Publish to Facebook
  const autoPublishFbBtn = $('#autoPublishFb');
  if (autoPublishFbBtn) {
    autoPublishFbBtn.onclick = () => {
      const isRePublish = post.status === 'MANUALLY_UPLOADED';
      modal(isRePublish ? 'Đăng lại bài tự động lên Facebook' : 'Đăng bài tự động lên Facebook', `
        <p class="muted">
          ${isRePublish ? '<span style="display:inline-block;padding:4px 8px;border-radius:4px;background:#fef3c7;color:#b45309;font-weight:600;font-size:12px;margin-bottom:8px">⚠️ Bài viết này đã được đăng trước đó</span><br>' : ''}
          Hệ thống sẽ dùng Meta Graph API đăng ${isRePublish ? 'lại' : 'trực tiếp'} bài <b>${esc(post.topic_title)}</b> và ảnh đính kèm lên Fanpage.
        </p>
        <label>Facebook Page đích (để trống sẽ tự nhận diện theo Token)
          <input name="pageTarget" value="${esc(post.facebook_page_id || '')}" placeholder="1356722127527894 hoặc link Page">
        </label>
        <label>Ghi chú (tùy chọn)
          <input name="note" placeholder="Ví dụ: Đăng lại bài">
        </label>
      `, async f => {
        autoPublishFbBtn.disabled = true;
        autoPublishFbBtn.textContent = '⏳ Đang đăng lên Facebook...';
        try {
          const res = await api(`/api/posts/${post.id}/publish-facebook`, {
            method: 'POST',
            body: JSON.stringify({
              pageTarget: f.get('pageTarget'),
              note: f.get('note')
            })
          });
          toast(res.message || 'Đã đăng bài thành công lên Facebook!');
          await renderStudio();
        } catch (err) {
          toast(`Lỗi đăng bài: ${err.message}`, true);
          autoPublishFbBtn.disabled = false;
          autoPublishFbBtn.textContent = isRePublish ? '↻ Đăng lại lên Facebook' : '🚀 Tự động đăng lên Facebook';
          return false;
        }
      });
    };
  }

  // Mark uploaded
  const markUploadedBtn = $('#markUploaded');
  if (markUploadedBtn) {
    markUploadedBtn.onclick = () => {
      modal('Xác nhận đã đăng thủ công lên Facebook', `
        <p class="muted">Xác nhận bạn đã copy caption, tải ảnh và đăng lên Fanpage của <b>${esc(post.profile_name)}</b>.</p>
        <label>Facebook Page đích
          <input name="pageTarget" required value="${esc(post.facebook_page_id || '')}" placeholder="Page ID hoặc https://facebook.com/ten-page">
        </label>
        <label>Ghi chú thêm (tùy chọn)
          <input name="note" placeholder="Ví dụ: Đã ghim bài lên đầu trang">
        </label>
      `, async f => {
        try {
          await api(`/api/posts/${post.id}/mark-manually-uploaded`, {
            method: 'POST',
            body: JSON.stringify({
              pageTarget: f.get('pageTarget'),
              note: f.get('note')
            })
          });
          toast('Đã đánh dấu hoàn tất đăng bài thành công!');
          renderStudio();
        } catch (err) {
          toast(`Lỗi: ${err.message}`, true);
          return false;
        }
      });
    };
  }
}

async function renderProfiles() {
  await fetchProfiles();
  $('#view').innerHTML = `
    <div class="panelhead">
      <div>
        <h2>Quản lý Content Profiles theo thương hiệu</h2>
        <p class="muted">Mỗi profile gắn với một thư mục Google Drive (RULES, TOPICS, MATERIALS, OUTPUT).</p>
      </div>
      <div class="toolbar">
        <button id="syncAllProfiles">📥 Đồng bộ tất cả</button>
        <button id="addProfile">＋ Thêm profile mới</button>
      </div>
    </div>
    <div class="cards">
      ${cachedProfiles.map(p => `
        <article class="card">
          <div class="brandline">
            ${mark(p)}
            <div>
              <h3>${esc(p.name)}</h3>
              <span class="pill">${esc(p.type)} · ${esc(p.brand || 'HBG')}</span>
            </div>
          </div>
          <div class="details">
            <span>Folder OUTPUT</span><b>${esc(p.folder_id_output || 'Chưa cấu hình')}</b>
            <span>Google Sheet ID</span><b>${esc(p.sheet_id_topics || 'Chưa cấu hình')}</b>
            <span>Facebook Page</span><b>${esc(p.page_name || 'Chưa cấu hình')}${p.facebook_page_id ? ` · ${esc(p.facebook_page_id)}` : ''}</b>
            <span>Giờ đăng mẫu</span><b>${esc(p.time || '09:00')} · GMT+7</b>
          </div>
          <div class="cardfoot">
            <span class="tag ${p.active ? 'approved' : ''}">${p.active ? 'Đang bật' : 'Tạm dừng'}</span>
            <div>
              <button data-sync="${p.id}" ${p.sheet_id_topics ? '' : 'disabled'}>📥 Đồng bộ Sheet</button>
              <button data-edit="${p.id}">Cấu hình</button>
              <button data-toggle="${p.id}">${p.active ? 'Tạm dừng' : 'Bật'}</button>
            </div>
          </div>
        </article>
      `).join('')}
    </div>
  `;

  $('#addProfile').onclick = () => editProfile();
  $('#syncAllProfiles').onclick = e => syncAllProfiles(e.currentTarget, renderProfiles);
  document.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = () => editProfile(cachedProfiles.find(p => p.id === b.dataset.edit));
  });
  document.querySelectorAll('[data-toggle]').forEach(b => {
    b.onclick = async () => {
      const p = cachedProfiles.find(x => x.id === b.dataset.toggle);
      if (p) {
        await api(`/api/profiles/${p.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...p, active: !p.active })
        });
        toast(`Đã đổi trạng thái ${p.name}`);
        renderProfiles();
      }
    };
  });
  document.querySelectorAll('[data-sync]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '⏳ Đang đồng bộ...';
      try {
        const res = await api(`/api/profiles/${b.dataset.sync}/sync-sheet`, { method: 'POST' });
        toast(`Đã đồng bộ xong! Thêm: ${res.imported}, Cập nhật: ${res.updated}`);
        renderProfiles();
      } catch (err) {
        toast(`Lỗi đồng bộ Sheet: ${err.message}`, true);
        b.disabled = false;
        b.textContent = '📥 Đồng bộ Sheet';
      }
    };
  });
}

function editProfile(p) {
  modal(p ? `Cấu hình profile · ${p.name}` : 'Thêm profile mới', `
    <label>Tên Profile<input name="name" value="${esc(p?.name || '')}" required maxlength="100"></label>
    <div class="formrow">
      <label>Thể loại<input name="type" value="${esc(p?.type || '')}" required placeholder="Hội nghị / Du lịch..."></label>
      <label>Giờ đăng dự kiến<input type="time" name="time" value="${p?.time || '09:00'}" required></label>
    </div>
    <div class="formrow">
      <label>Thư mục Drive RULES (ID hoặc đường dẫn)<input name="folder_id_rules" value="${esc(p?.folder_id_rules || '')}" placeholder="Khuyên dùng Folder ID, ví dụ: 1a2B..."></label>
      <label>Thư mục Drive OUTPUT (ID hoặc đường dẫn)<input name="folder_id_output" value="${esc(p?.folder_id_output || '')}" placeholder="Khuyên dùng Folder ID, ví dụ: 1a2B..."></label>
    </div>
    <p class="muted">Mở từng thư mục trên Google Drive và sao chép phần ID sau <b>/folders/</b> trong URL. Folder ID ổn định hơn đường dẫn theo tên.</p>
    <label>Google Sheet ID chứa tab TOPICS<input name="sheet_id_topics" value="${esc(p?.sheet_id_topics || '')}" placeholder="Ví dụ: 1BxiMVs0XR..."></label>
    <div class="formrow">
      <label>Tên Facebook Page<input name="page_name" value="${esc(p?.page_name || '')}" placeholder="Ví dụ: Danang Events"></label>
      <label>Facebook Page ID hoặc link<input name="facebook_page_id" value="${esc(p?.facebook_page_id || '')}" placeholder="123456789012345 hoặc https://facebook.com/ten-page"></label>
    </div>
    <p class="muted">Mỗi Content Profile gắn với một Facebook Page. ID hoặc link này sẽ tự động là đích đăng mặc định của các bài thuộc profile.</p>
  `, async f => {
    try {
      const payload = {
        name: f.get('name').trim(),
        type: f.get('type').trim(),
        time: f.get('time'),
        folder_id_rules: f.get('folder_id_rules').trim(),
        folder_id_output: f.get('folder_id_output').trim(),
        sheet_id_topics: f.get('sheet_id_topics').trim(),
        page_name: f.get('page_name').trim(),
        facebook_page_id: f.get('facebook_page_id').trim(),
        active: p ? p.active : true
      };
      if (p) {
        await api(`/api/profiles/${p.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Cập nhật Profile thành công!');
      } else {
        await api('/api/profiles', { method: 'POST', body: JSON.stringify(payload) });
        toast('Tạo Profile mới thành công!');
      }
      renderProfiles();
    } catch (err) {
      toast(`Lỗi: ${err.message}`, true);
      return false;
    }
  });
}

async function renderRules() {
  await fetchProfiles();
  const rulesByProfile = [];
  for (const p of cachedProfiles) {
    try {
      const rules = await api(`/api/profiles/${p.id}/rules`);
      rulesByProfile.push({ profile: p, latestRule: rules[0] || null });
    } catch {}
  }

  $('#view').innerHTML = `
    <div class="cards">
      ${rulesByProfile.map(({ profile, latestRule }) => `
        <section class="card">
          <div class="panelhead">
            <h2>${esc(profile.name)}</h2>
            <span class="tag">Rule v${latestRule?.version || 1}</span>
          </div>
          <div class="ruletext">${esc(latestRule?.content_markdown || 'Chưa có rule')}</div>
          <div class="actions">
            <button data-rule="${profile.id}">Chỉnh sửa & Tạo Rule Version mới</button>
          </div>
        </section>
      `).join('')}
    </div>
  `;

  document.querySelectorAll('[data-rule]').forEach(b => {
    b.onclick = async () => {
      const p = cachedProfiles.find(x => x.id === b.dataset.rule);
      const rules = await api(`/api/profiles/${p.id}/rules`);
      const currentRule = rules[0]?.content_markdown || '';

      modal(`Quy tắc thương hiệu · ${p.name}`, `
        <label>Nội dung Rule (Markdown)
          <textarea name="rule" rows="14" required>${esc(currentRule)}</textarea>
        </label>
        <p class="muted">Tạo version mới sẽ giữ nguyên snapshot của các bài viết cũ đã tạo trước đó.</p>
      `, async f => {
        try {
          await api(`/api/profiles/${p.id}/rules`, {
            method: 'POST',
            body: JSON.stringify({ contentMarkdown: f.get('rule') })
          });
          toast('Đã tạo Rule version mới thành công!');
          renderRules();
        } catch (err) {
          toast(`Lỗi: ${err.message}`, true);
          return false;
        }
      });
    };
  });
}

async function renderCalendar() {
  await fetchProfiles();
  let topics = [];
  try {
    [cachedPosts, topics] = await Promise.all([api('/api/posts'), api('/api/topics?all=true')]);
  } catch (err) {
    toast(`Không tải được lịch nội dung: ${err.message}`, true);
  }

  const topicKeys = new Set(topics.map(t => `${t.profile_id}:${t.topic_id}`));
  const entries = topics.map(t => ({
    date: t.content_date,
    time: t.publish_time || '09:00',
    title: t.topic_title,
    profileName: t.profile_name || t.profile_id,
    postId: t.post_id,
    status: t.post_status || `SHEET_${t.status}`
  }));
  for (const post of cachedPosts) {
    if (post.topic_id && topicKeys.has(`${post.profile_id}:${post.topic_id}`)) continue;
    entries.push({
      date: post.content_date,
      time: post.scheduled_time || '09:00',
      title: post.topic_title,
      profileName: post.profile_name,
      postId: post.id,
      status: post.status
    });
  }

  const [year, month] = calendarMonth.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDayOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const monthLabel = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  const days = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${calendarMonth}-${String(day).padStart(2, '0')}`;
    const dateEntries = entries.filter(item => item.date === date).sort((a, b) => a.time.localeCompare(b.time));
    days.push(`<div class="day"><b>${day}</b>${dateEntries.map(item => {
      const statusText = item.status.startsWith('SHEET_')
        ? `Từ Sheet · ${item.status.slice(6)}`
        : (labels[item.status] || item.status);
      return `<div class="calitem" ${item.postId ? `data-open="${esc(item.postId)}"` : ''}>
        ${esc(item.time)} · ${esc(item.profileName)}<br>${esc(item.title)}<br>${esc(statusText)}
      </div>`;
    }).join('')}</div>`);
  }

  const undated = entries.filter(item => !/^\d{4}-\d{2}-\d{2}$/.test(item.date || ''));
  $('#view').innerHTML = `
    <section class="panel">
      <div class="panelhead">
        <div><h2>${esc(monthLabel)}</h2><span class="muted">Toàn bộ lịch từ Sheet và các bài đã tạo · GMT+7</span></div>
        <div class="toolbar">
          <button id="prevMonth">‹ Tháng trước</button>
          <input id="calendarMonth" type="month" value="${esc(calendarMonth)}">
          <button id="nextMonth">Tháng sau ›</button>
        </div>
      </div>
      <div class="tablewrap"><div class="calendar">
        ${['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(d => `<div class="calheading">${d}</div>`).join('')}
        ${'<div class="day"></div>'.repeat(firstDayOffset)}${days.join('')}
      </div></div>
    </section>
    ${undated.length ? `<section class="panel"><h2>Lịch chưa có ngày</h2>${undated.map(item => `<div class="check"><span>${esc(item.title)}<small>${esc(item.profileName)}</small></span><b>${esc(item.status)}</b></div>`).join('')}</section>` : ''}
  `;

  const moveMonth = delta => {
    const next = new Date(year, month - 1 + delta, 1);
    calendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    renderCalendar();
  };
  $('#prevMonth').onclick = () => moveMonth(-1);
  $('#nextMonth').onclick = () => moveMonth(1);
  $('#calendarMonth').onchange = e => { calendarMonth = e.target.value; renderCalendar(); };
  document.querySelectorAll('[data-open]').forEach(item => {
    item.onclick = () => { currentPostId = item.dataset.open; goto('studio'); };
  });
}

async function renderLogs() {
  let logs = [];
  try {
    logs = await api('/api/audit-logs');
  } catch {}

  $('#view').innerHTML = `
    <section class="panel">
      <h2>Nhật ký kiểm toán hệ thống (Audit Events)</h2>
      <p class="muted">Lưu vết bền vững mọi thao tác duyệt, xuất file và đánh dấu đăng bài.</p>
      ${logs.map(l => `
        <div class="log">
          <time>${new Date(l.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</time>
          <div>
            <strong>${esc(l.action)}</strong>
            <small>Actor: ${esc(l.actor_id)} · Entity: ${esc(l.entity_type)} (${esc(l.entity_id)})</small>
            ${l.details_json ? `<small style="color:var(--muted)">${esc(l.details_json)}</small>` : ''}
          </div>
        </div>
      `).join('') || '<div class="empty">Chưa có nhật ký nào trong cơ sở dữ liệu.</div>'}
    </section>
  `;
}

async function renderSettings() {
  await fetchStatus();
  if ($('#appVersion')) $('#appVersion').textContent = `v${serverStatus?.appVersion || '...'}`;
  const appConfig = await api('/api/app-config');

  const googleOk = serverStatus?.services?.googleDrive?.configured;
  const openaiOk = serverStatus?.services?.openai?.configured;
  const metaOk = serverStatus?.services?.facebook?.configured;

  $('#view').innerHTML = `
    <div class="layout">
      <section class="panel">
        <div class="panelhead">
          <h2>Kết nối dịch vụ (Backend Server)</h2>
          <button id="refreshStatus" style="padding:6px 12px;font-size:12px">🔄 Kiểm tra lại</button>
        </div>

        <div class="check ${googleOk ? 'pass' : ''}">
          <span>
            Google Drive / Sheets
            <small>${esc(serverStatus?.services?.googleDrive?.detail || 'Chưa cấu hình')}</small>
          </span>
          <b>${googleOk ? 'Đã liên kết' : 'Chưa xác thực'}</b>
        </div>
        <div style="margin: 10px 0 20px 0">
          ${googleOk ? `
            <button id="testProbeBtn" style="font-size:13px">🧪 Kiểm tra quyền ghi Drive (Probe Test)</button>
          ` : `
            <button id="connectGoogleBtn" class="primary" style="font-size:13px">🔗 Bấm để Kết nối Google Drive qua OAuth</button>
          `}
        </div>

        <div class="check ${openaiOk ? 'pass' : ''}">
          <span>
            OpenAI API (Text & Image)
            <small>${esc(serverStatus?.services?.openai?.detail || 'Chưa cấu hình')}</small>
          </span>
          <b>${openaiOk ? 'Đã kết nối' : 'Chưa có key'}</b>
        </div>

        <div class="check ${metaOk ? 'pass' : ''}">
          <span>
            Meta / Facebook Pages
            <small>${esc(serverStatus?.services?.facebook?.detail || '')}</small>
          </span>
          <b>${serverStatus?.services?.facebook?.hasPageToken ? 'Đã kết nối Page' : (metaOk ? 'Đã cấu hình App' : 'Chưa cấu hình')}</b>
        </div>
        <div style="margin: 10px 0 20px 0">
          <button id="testMetaBtn" ${metaOk ? '' : 'disabled'} style="font-size:13px">🧪 Kiểm tra kết nối Meta App & Page</button>
        </div>

        <div class="check pass">
          <span>
            Scheduler & Mode
            <small>${esc(serverStatus?.services?.scheduler?.detail || '')}</small>
          </span>
          <b>Sẵn sàng</b>
        </div>
      </section>

      <section class="panel">
        <h2>Thông tin vận hành</h2>
        <div class="details">
          <span>Môi trường</span><b>${esc(serverStatus?.env || 'development')}</b>
          <span>Múi giờ</span><b>${esc(serverStatus?.timezone || 'Asia/Ho_Chi_Minh')}</b>
          <span>Chế độ xuất</span><b>Chờ đăng thủ công (Manual Upload)</b>
          <span>Cơ sở dữ liệu</span><b>SQLite bền vững (data/content_studio.sqlite)</b>
        </div>
      </section>
    </div>

    <section class="panel" style="margin-top:20px">
      <div class="panelhead">
        <div>
          <h2>Cấu hình ứng dụng</h2>
          <p class="muted">Các giá trị được lưu cục bộ. Trường bí mật để trống sẽ giữ nguyên giá trị hiện tại.</p>
        </div>
      </div>
      <form id="appConfigForm">
        <div id="appConfigFields"></div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:18px">
          <button class="primary" type="submit">💾 Lưu cấu hình</button>
          <small class="muted">Khởi động lại ứng dụng sau khi lưu để áp dụng đầy đủ.</small>
        </div>
      </form>
    </section>
  `;

  const configGroups = [
    ['Vận hành', [
      ['NODE_ENV', 'Môi trường', 'text'],
      ['APP_TIMEZONE', 'Múi giờ', 'text'],
      ['PUBLISH_MODE', 'Chế độ xuất bản', 'text'],
      ['DRIVE_OUTPUT_REQUIRED', 'Bắt buộc xuất Drive', 'boolean'],
      ['AUTOMATION_ENABLED', 'Bật tự động hóa', 'boolean'],
      ['AUTOMATION_INTERVAL_MINUTES', 'Chu kỳ tự động (phút)', 'number']
    ]],
    ['OpenAI', [
      ['OPENAI_API_KEY', 'API key', 'password'],
      ['OPENAI_TEXT_MODEL', 'Model nội dung', 'text'],
      ['OPENAI_IMAGE_MODEL', 'Model hình ảnh', 'text']
    ]],
    ['Google', [
      ['GOOGLE_CLIENT_ID', 'Client ID', 'text'],
      ['GOOGLE_CLIENT_SECRET', 'Client secret', 'password'],
      ['GOOGLE_REDIRECT_URI', 'OAuth redirect URI', 'text']
    ]],
    ['Meta / Facebook', [
      ['META_APP_ID', 'App ID', 'text'],
      ['META_APP_SECRET', 'App secret', 'password'],
      ['META_GRAPH_VERSION', 'Graph API version', 'text'],
      ['FACEBOOK_PAGE_ACCESS_TOKEN', 'Page / System User Access Token', 'password']
    ]],
    ['Bảo mật và dịch vụ nâng cao', [
      ['TOKEN_ENCRYPTION_KEY', 'Khóa mã hóa token', 'password'],
      ['AUTH_SECRET', 'Khóa phiên đăng nhập', 'password'],
      ['DATABASE_URL', 'Database URL (dự phòng)', 'text'],
      ['REDIS_URL', 'Redis URL (dự phòng)', 'text'],
      ['OBJECT_STORAGE_ENDPOINT', 'Object storage endpoint', 'text'],
      ['OBJECT_STORAGE_BUCKET', 'Object storage bucket', 'text'],
      ['OBJECT_STORAGE_ACCESS_KEY', 'Object storage access key', 'password'],
      ['OBJECT_STORAGE_SECRET_KEY', 'Object storage secret key', 'password']
    ]]
  ];

  $('#appConfigFields').innerHTML = configGroups.map(([title, fields]) => `
    <fieldset style="border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0">
      <legend style="padding:0 8px;font-weight:700">${esc(title)}</legend>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
        ${fields.map(([key, label, type]) => {
          const item = appConfig.settings[key] || {};
          if (type === 'boolean') return `
            <label style="display:flex;align-items:center;gap:10px;margin-top:24px">
              <input data-config-key="${key}" type="checkbox" ${item.value === 'true' ? 'checked' : ''} style="width:auto">
              ${esc(label)}
            </label>`;
          const placeholder = item.secret && item.configured ? 'Đã cấu hình — để trống để giữ nguyên' : '';
          return `<label>${esc(label)}
            <input data-config-key="${key}" type="${type}" value="${esc(item.value || '')}" placeholder="${esc(placeholder)}" autocomplete="off">
          </label>`;
        }).join('')}
      </div>
    </fieldset>
  `).join('');

  $('#appConfigForm').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    const settings = {};
    document.querySelectorAll('[data-config-key]').forEach(input => {
      settings[input.dataset.configKey] = input.type === 'checkbox' ? String(input.checked) : input.value;
    });
    try {
      await api('/api/app-config', { method: 'PUT', body: JSON.stringify({ settings }) });
      toast('Đã lưu cấu hình. Hãy đóng và mở lại ứng dụng để áp dụng đầy đủ.');
      await renderSettings();
    } catch (err) {
      toast(`Không thể lưu cấu hình: ${err.message}`, true);
    } finally {
      button.disabled = false;
    }
  };

  $('#refreshStatus').onclick = () => renderSettings();

  const connectGoogleBtn = $('#connectGoogleBtn');
  if (connectGoogleBtn) {
    connectGoogleBtn.onclick = async () => {
      try {
        const res = await api('/api/oauth/google/start');
        if (res.url) {
          window.location.href = res.url;
        }
      } catch (err) {
        toast(`Lỗi: ${err.message}`, true);
      }
    };
  }

  const testProbeBtn = $('#testProbeBtn');
  if (testProbeBtn) {
    testProbeBtn.onclick = async () => {
      testProbeBtn.disabled = true;
      testProbeBtn.textContent = '⏳ Đang kiểm tra ghi probe...';
      try {
        const res = await api('/api/connections/google/test', { method: 'POST' });
        toast(res.message || 'Kiểm tra thành công!');
      } catch (err) {
        toast(`Lỗi probe: ${err.message}`, true);
      } finally {
        testProbeBtn.disabled = false;
        testProbeBtn.textContent = '🧪 Kiểm tra quyền ghi Drive (Probe Test)';
      }
    };
  }

  const testMetaBtn = $('#testMetaBtn');
  if (testMetaBtn) {
    testMetaBtn.onclick = async () => {
      testMetaBtn.disabled = true;
      testMetaBtn.textContent = '⏳ Đang xác thực với Meta...';
      try {
        const res = await api('/api/connections/meta/test', { method: 'POST' });
        toast(res.message || 'Kết nối Meta App thành công!');
      } catch (err) {
        toast(err.message, true);
      } finally {
        testMetaBtn.disabled = !metaOk;
        testMetaBtn.textContent = '🧪 Kiểm tra kết nối Meta App';
      }
    };
  }
}

$('#closeModal').onclick = $('#cancelModal').onclick = () => $('#modal').close();
window.addEventListener('hashchange', render);
render();
