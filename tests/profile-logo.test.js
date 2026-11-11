import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { applyProfileLogo } from '../src/image/logo.js';

async function solidImageData(width = 600, height = 400) {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } }
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

test('applyProfileLogo uses the app logo when a profile has no uploaded logo', async () => {
  const source = await solidImageData();
  const result = await applyProfileLogo(source, null);

  assert.match(result, /^data:image\/png;base64,/);
  assert.notEqual(result, source);
  const metadata = await sharp(Buffer.from(result.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, 600);
  assert.equal(metadata.height, 400);
});

test('applyProfileLogo still prefers an uploaded profile logo', async () => {
  const source = await solidImageData();
  const customLogoBuffer = await sharp({
    create: { width: 80, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
  const customLogo = `data:image/png;base64,${customLogoBuffer.toString('base64')}`;

  const withCustomLogo = await applyProfileLogo(source, customLogo);
  const withDefaultLogo = await applyProfileLogo(source, null);
  assert.notEqual(withCustomLogo, withDefaultLogo);
});
