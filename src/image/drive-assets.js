import sharp from 'sharp';
import { downloadFileBuffer, getFileMetadata, listFolderFiles } from '../google/drive.js';
import { readMediaBuffer } from '../media.js';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function extractDriveId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{15,}$/.test(raw)) return raw;
  const match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/)
    || raw.match(/\/d\/([a-zA-Z0-9_-]+)/)
    || raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error(`Link Google Drive không hợp lệ: ${raw}`);
  return match[1];
}

export async function loadDriveImages(link, maxFiles = 10) {
  const id = extractDriveId(link);
  if (!id) return [];
  const metadata = await getFileMetadata(id);
  const files = metadata.mimeType === FOLDER_MIME
    ? (await listFolderFiles(id)).filter(file => IMAGE_MIMES.has(file.mimeType)).slice(0, maxFiles)
    : [metadata];
  if (!files.length) throw new Error('Link nguồn ảnh không chứa file PNG, JPEG hoặc WebP hợp lệ.');
  if (files.some(file => !IMAGE_MIMES.has(file.mimeType))) {
    throw new Error('Link Drive phải trỏ đến ảnh PNG, JPEG, WebP hoặc thư mục chứa ảnh.');
  }
  return Promise.all(files.map(async file => ({ ...file, buffer: await downloadFileBuffer(file.id) })));
}

export async function applyDriveFrame(imageData, frameLink) {
  if (!String(frameLink || '').trim()) return imageData;
  const [frame] = await loadDriveImages(frameLink, 1);
  const imageBuffer = readMediaBuffer(imageData);
  if (!imageBuffer) throw new Error('Không đọc được ảnh cần lắp khung.');
  const base = sharp(imageBuffer);
  const metadata = await base.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const overlay = await sharp(frame.buffer).resize(width, height, { fit: 'fill' }).png().toBuffer();
  const output = await base.composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer();
  return `data:image/png;base64,${output.toString('base64')}`;
}
