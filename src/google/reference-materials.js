import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { downloadFileBuffer, downloadFileContent, getFileMetadata, listFolderFiles } from './drive.js';
import { extractDriveId } from '../image/drive-assets.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

async function extractText(file) {
  if (file.mimeType === GOOGLE_DOC_MIME || TEXT_MIMES.has(file.mimeType)) {
    return downloadFileContent(file.id, file.mimeType);
  }
  const buffer = await downloadFileBuffer(file.id);
  if (file.mimeType === DOCX_MIME || /\.docx$/i.test(file.name || '')) {
    return (await mammoth.extractRawText({ buffer })).value;
  }
  if (file.mimeType === PDF_MIME || /\.pdf$/i.test(file.name || '')) {
    const parser = new PDFParse({ data: buffer });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  return '';
}

export async function loadReferenceMaterials(link, { maxFiles = 12, maxCharacters = 60000 } = {}) {
  const id = extractDriveId(link);
  if (!id) return '';
  const metadata = await getFileMetadata(id);
  const files = metadata.mimeType === FOLDER_MIME ? await listFolderFiles(id) : [metadata];
  const sections = [];
  let length = 0;
  for (const file of files.slice(0, maxFiles)) {
    let content = '';
    try { content = String(await extractText(file) || '').trim(); } catch { continue; }
    if (!content) continue;
    const remaining = maxCharacters - length;
    if (remaining <= 0) break;
    content = content.slice(0, remaining);
    sections.push(`### ${file.name}\n${content}`);
    length += content.length;
  }
  return sections.join('\n\n');
}
