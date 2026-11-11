import sharp from 'sharp';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMediaBuffer } from '../media.js';

const DEFAULT_LOGO_PATH = fileURLToPath(new URL('../../dist/assets/the-hbg-logo.png', import.meta.url));

function getLogoBuffer(logoData) {
  const profileLogo = readMediaBuffer(logoData);
  if (profileLogo) return profileLogo;
  return fs.existsSync(DEFAULT_LOGO_PATH) ? fs.readFileSync(DEFAULT_LOGO_PATH) : null;
}

export async function applyProfileLogo(imageData, logoData) {
  const imageBuffer = readMediaBuffer(imageData);
  const logoBuffer = getLogoBuffer(logoData);
  if (!imageBuffer || !logoBuffer) return imageData;

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const margin = Math.max(24, Math.round(Math.min(width, height) * 0.035));
  const logo = await sharp(logoBuffer)
    .resize({ width: Math.round(width * 0.2), height: Math.round(height * 0.13), fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const logoMeta = await sharp(logo).metadata();

  const output = await image
    .composite([{ input: logo, left: width - (logoMeta.width || 0) - margin, top: height - (logoMeta.height || 0) - margin }])
    .png()
    .toBuffer();
  return `data:image/png;base64,${output.toString('base64')}`;
}
