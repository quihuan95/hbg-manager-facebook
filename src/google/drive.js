import { getValidAccessToken } from './oauth.js';

export async function resolveFolder(folderPathOrId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive hoặc cần kết nối lại (NEEDS_RECONNECT).');

  const requestedFolder = String(folderPathOrId || '').trim();
  if (!requestedFolder) throw new Error('Chưa nhập ID hoặc đường dẫn thư mục Google Drive.');

  // If it's already a folder ID (alphanumeric, e.g. 1a2B3c...)
  if (/^[a-zA-Z0-9_-]{15,}$/.test(requestedFolder)) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${requestedFolder}?fields=id,name,mimeType,trashed`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (!data.trashed && data.mimeType === 'application/vnd.google-apps.folder') {
        return data;
      }
    }
  }

  // Resolve slash-separated paths from My Drive root, e.g. HBG_MICE/OUTPUT.
  const pathParts = requestedFolder.split('/').map(part => part.trim()).filter(Boolean);
  let parentId = 'root';
  let resolvedFolder = null;

  for (const folderName of pathParts) {
    const escapedName = folderName.replace(/'/g, "\\'");
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and trashed = false`;
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)&pageSize=2`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!searchRes.ok) {
      throw new Error(`Lỗi tìm kiếm thư mục Drive: ${searchRes.statusText}`);
    }

    const data = await searchRes.json();
    if (!data.files || data.files.length === 0) {
      throw new Error(`Không tìm thấy thư mục "${folderName}" trong đường dẫn "${requestedFolder}" trên My Drive.`);
    }

    resolvedFolder = data.files[0];
    parentId = resolvedFolder.id;
  }

  return resolvedFolder;
}

export async function listFolderFiles(folderId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive.');

  const query = `'${folderId}' in parents and trashed = false`;
  let files = [];
  let pageToken = null;

  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime)');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Lỗi đọc danh sách file từ Drive: ${res.statusText}`);
    }

    const data = await res.json();
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

export async function downloadFileContent(fileId, mimeType) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive.');

  let url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    throw new Error(`Lỗi tải nội dung file (${fileId}): ${res.statusText}`);
  }

  return await res.text();
}

export async function downloadFileBuffer(fileId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive.');

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    throw new Error(`Lỗi tải binary file (${fileId}): ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function createFolder(parentFolderId, folderName) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive.');

  // Check if exists first
  const query = `'${parentFolderId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (searchRes.ok) {
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      return searchData.files[0];
    }
  }

  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    })
  });

  if (!res.ok) {
    throw new Error(`Không thể tạo thư mục "${folderName}" trên Drive: ${res.statusText}`);
  }

  return await res.json();
}

export async function uploadFileToDrive(parentFolderId, fileName, mimeType, contentBuffer) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive.');

  // Check if file already exists in parent folder for idempotency
  const query = `'${parentFolderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`;
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  let existingFileId = null;
  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.files && data.files.length > 0) {
      existingFileId = data.files[0].id;
    }
  }

  const metadata = {
    name: fileName,
    parents: existingFileId ? undefined : [parentFolderId]
  };

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)),
    Buffer.from(`${delimiter}Content-Type: ${mimeType}\r\n\r\n`),
    Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer),
    Buffer.from(closeDelimiter)
  ]);

  const endpoint = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  const res = await fetch(endpoint, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Upload file "${fileName}" lên Drive thất bại: ${err.error?.message || res.statusText}`);
  }

  return await res.json();
}

export async function probeDriveWrite(outputFolderId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Chưa kết nối Google Drive.');

  const probeName = `.probe_write_${Date.now()}.tmp`;
  try {
    const uploadRes = await uploadFileToDrive(outputFolderId, probeName, 'text/plain', 'HBG Content Studio write test probe');
    if (!uploadRes.id) throw new Error('Probe upload không trả file ID');

    // Clean up probe
    await fetch(`https://www.googleapis.com/drive/v3/files/${uploadRes.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    return { success: true, message: 'Kiểm tra quyền ghi OUTPUT thành công.' };
  } catch (err) {
    return { success: false, message: `Lỗi kiểm tra quyền ghi: ${err.message}` };
  }
}
