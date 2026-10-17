/**
 * Phusion Passenger entry for Flight Eye on shared hosting (cPanel's
 * "Setup Node.js App", as at o2switch). Passenger requires this file and
 * then waits for the HTTP server it creates to call listen(), which
 * Passenger redirects onto its own socket; the port the server asks for
 * does not matter there. See deploy/CPANEL.md.
 *
 * CommonJS on purpose: Passenger loads the entry with require(), and the
 * serve script is an ES module with top-level await, which require() cannot
 * load. The dynamic import below starts it and lets Passenger wait.
 *
 * Outside Passenger (`node passenger.cjs`) this is the same as
 * `npm run serve:flight-eye` on 127.0.0.1:4173.
 */

'use strict';

process.env.HOST ||= '127.0.0.1';

import('./scripts/serve-flight-eye.mjs').catch((error) => {
  console.error('[Flight Eye] the server failed to start:', error);
  process.exit(1);
});
