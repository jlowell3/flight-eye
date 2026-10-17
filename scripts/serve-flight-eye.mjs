#!/usr/bin/env node
/**
 * Serve the Flight Eye build with the app's API routes: Vite's preview
 * server over dist-flight-eye, bound to every interface so a phone on the
 * network (or a reverse proxy in front) can reach it. HOST, PORT and
 * GEV_ALLOWED_HOSTS come from the environment or .env as for `npm run dev`.
 * Run `npm run build:flight-eye` first.
 */

import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import standaloneConfig from '../server/standalone/vite.config.js';

const FLIGHT_EYE_OUT_DIR = 'dist-flight-eye';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = standaloneConfig({ command: 'serve', mode: 'production' });
const server = await preview({
  configFile: false,
  root,
  ...config,
  build: { ...config.build, outDir: FLIGHT_EYE_OUT_DIR },
  preview: {
    ...config.preview,
    host: process.env.HOST || '0.0.0.0',
    port: Number.parseInt(process.env.PORT, 10) || 4173,
    strictPort: true,
    allowedHosts: config.server?.allowedHosts,
  },
});
server.printUrls();
