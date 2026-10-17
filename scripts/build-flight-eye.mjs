#!/usr/bin/env node
/**
 * Build Flight Eye, the aircraft-only app, under dist-flight-eye. The page
 * is flight-eye.html (src/flightEye/main.js); the output names it index.html
 * so `npm run serve:flight-eye` serves it at the root.
 */

import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import standaloneConfig from '../server/standalone/vite.config.js';

export const FLIGHT_EYE_OUT_DIR = 'dist-flight-eye';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = standaloneConfig({ command: 'build', mode: 'production' });
await build({
  configFile: false,
  root,
  ...config,
  build: {
    ...config.build,
    outDir: FLIGHT_EYE_OUT_DIR,
    emptyOutDir: true,
    rollupOptions: {
      ...config.build?.rollupOptions,
      input: join(root, 'flight-eye.html'),
    },
  },
});

const outDir = join(root, FLIGHT_EYE_OUT_DIR);
await rename(join(outDir, 'flight-eye.html'), join(outDir, 'index.html'));
console.log(`Flight Eye build written to ${FLIGHT_EYE_OUT_DIR}`);
