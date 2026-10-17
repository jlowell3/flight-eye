#!/usr/bin/env node
/**
 * Regenerates the Android launcher icons, the splash logo and the Flutter
 * loading-screen logo from the web app's assets (public/icons/*.png and
 * public/logo.svg). Uses sharp from the repository's node_modules, so run
 * `npm install` at the repo root first, then from the repo root:
 *
 *   node mobile/tool/make-icons.mjs
 */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../package.json', import.meta.url));
const sharp = require('sharp');

const repo = fileURLToPath(new URL('../../', import.meta.url));
const res = path.join(repo, 'mobile', 'android', 'app', 'src', 'main', 'res');
const assets = path.join(repo, 'mobile', 'assets');
const icon = path.join(repo, 'public', 'icons', 'icon-512.png');
const maskable = path.join(repo, 'public', 'icons', 'icon-512-maskable.png');
const logo = path.join(repo, 'public', 'logo.svg');

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function write(src, dir, name, px, options = {}) {
  await mkdir(dir, { recursive: true });
  await sharp(src, options).resize(px, px, { fit: 'contain', background: { r: 10, g: 10, b: 15, alpha: 0 } })
    .png().toFile(path.join(dir, name));
}

for (const [density, scale] of Object.entries(densities)) {
  const dir = path.join(res, `mipmap-${density}`);
  // Legacy launcher icon, 48dp.
  await write(icon, dir, 'ic_launcher.png', Math.round(48 * scale));
  // Adaptive icon foreground, 108dp. The maskable icon keeps its content
  // inside the inner 80 %, which clears the 66 % safe zone comfortably.
  await write(maskable, dir, 'ic_launcher_foreground.png', Math.round(108 * scale));
}

// Splash logo, 160dp wide, rasterised from the SVG (viewBox 775x520) onto
// the page background, which is what the web app shows it over.
for (const [density, scale] of Object.entries(densities)) {
  const dir = path.join(res, `drawable-${density}`);
  await mkdir(dir, { recursive: true });
  const width = Math.round(160 * scale);
  await sharp(logo, { density: 300 }).resize({ width }).flatten({ background: '#0a0a0f' }).png().toFile(path.join(dir, 'splash_logo.png'));
}

// Flutter loading-screen logo.
await mkdir(assets, { recursive: true });
await sharp(logo, { density: 300 }).resize({ width: 640 }).flatten({ background: '#0a0a0f' }).png().toFile(path.join(assets, 'logo.png'));

console.log('icons written to', res, 'and', assets);
