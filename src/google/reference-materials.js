import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { downloadFileBuffer, downloadFileContent, getFileMetadata, listFolderFiles } from './drive.js';
import { extractDriveId } from '../image/drive-assets.js';
import { config } from '../config.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

async function extractScannedPdf(buffer, filename) {
  if (!config.openai.apiKey) throw new Error(`PDF "${filename}" là bản scan nhưng chưa cấu hình OPENAI_API_KEY để OCR.`);
  if (buffer.length > 50 * 1024 * 1024) throw new Error(`PDF "${filename}" vượt quá giới hạn 50 MB để OCR.`);
  const parser = new PDFParse({ data: buffer });
  const chunks = [];
  try {
    const info = await parser.getInfo();
    const totalPages = info.total || 0;
    for (let start = 1; start <= totalPages; start += 6) {
      const pageNumbers = Array.from({ length: Math.min(6, totalPages - start + 1) }, (_, index) => start + index);
      const screenshots = await parser.getScreenshot({ partial: pageNumbers, desiredWidth: 1400 });
      const content = [
        {
          type: 'text',
          text: `OCR chính xác các trang ${pageNumbers.join(', ')} của tài liệu "${filename}". Ghi lại nội dung chữ, tiêu đề, tên riêng, ngày tháng, số liệu và các ý nghĩa được nêu trong ảnh. Không suy diễn hoặc bổ sung kiến thức bên ngoài. Nếu trang không có chữ, ghi [không có chữ].`
        },
        ...screenshots.pages.map(page => ({
          type: 'image_url',
          image_url: { url: page.dataUrl, detail: 'high' }
        }))
      ];
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`
        },
        body: JSON.stringify({
          model: config.openai.ocrModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content }],
          temperature: 0,
          max_tokens: 3500
        })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(`OCR trang ${pageNumbers.join('-')} thất bại: ${error.error?.message || res.statusText}`);
      }
      const data = await res.json();
      const text = String(data.choices?.[0]?.message?.content || '').trim();
      if (!text || /không thể (trích xuất|đọc)/i.test(text)) {
        throw new Error(`OCR không trả về nội dung cho trang ${pageNumbers.join('-')}.`);
      }
      chunks.push(`## Trang ${pageNumbers.join(', ')}\n${text}`);
    }
  } finally {
    await parser.destroy();
  }
  const content = chunks.join('\n\n').trim();
  if (!content) throw new Error(`Không OCR được nội dung từ PDF "${filename}".`);
  return content;
}

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
    let text = '';
    try { text = (await parser.getText()).text || ''; } finally { await parser.destroy(); }
    const meaningfulText = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').trim();
    return meaningfulText.length >= 200 ? meaningfulText : extractScannedPdf(buffer, file.name);
  }
  return '';
}

async function listFilesRecursively(folderId, maxFiles, depth = 0) {
  if (depth > 4 || maxFiles <= 0) return [];
  const children = await listFolderFiles(folderId);
  const files = [];
  for (const child of children) {
    if (files.length >= maxFiles) break;
    if (child.mimeType === FOLDER_MIME) {
      files.push(...await listFilesRecursively(child.id, maxFiles - files.length, depth + 1));
    } else {
      files.push(child);
    }
  }
  return files.slice(0, maxFiles);
}

export async function loadReferenceMaterials(link, { maxFiles = 12, maxCharacters = 60000 } = {}) {
  const id = extractDriveId(link);
  if (!id) return '';
  const metadata = await getFileMetadata(id);
  const files = metadata.mimeType === FOLDER_MIME
    ? await listFilesRecursively(id, maxFiles)
    : [metadata];
  const sections = [];
  let length = 0;
  for (const file of files.slice(0, maxFiles)) {
    let content = '';
    try {
      content = String(await extractText(file) || '').trim();
    } catch (error) {
      const supported = file.mimeType === GOOGLE_DOC_MIME
        || file.mimeType === PDF_MIME
        || file.mimeType === DOCX_MIME
        || TEXT_MIMES.has(file.mimeType)
        || /\.(pdf|docx)$/i.test(file.name || '');
      if (supported) throw new Error(`Không đọc được tài liệu tham khảo "${file.name}": ${error.message}`);
      continue;
    }
    if (!content) continue;
    const remaining = maxCharacters - length;
    if (remaining <= 0) break;
    content = content.slice(0, remaining);
    sections.push(`### ${file.name}\n${content}`);
    length += content.length;
  }
  return sections.join('\n\n');
}
