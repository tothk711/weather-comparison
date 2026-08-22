'use strict';
// Express wiring: static files, security headers, routes, 404 and the error
// handler v2.0 never had.

const express = require('express');
const path = require('path');
const { config } = require('./config');
const logger = require('./logger');
const routes = require('./routes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.security.trustProxy) app.set('trust proxy', 1); // Railway sits behind a proxy

  // Minimal hardening without pulling in a dependency. The dashboard loads
  // everything from its own origin now (Chart.js is vendored in public/vendor),
  // so a strict CSP is finally possible.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    next();
  });

  // No route reads a body; keep the limit tight anyway.
  app.use(express.json({ limit: '16kb' }));

  // Absolute, not cwd-relative: v2.0 served a blank page if the app was started
  // from anywhere but the repo root.
  app.use(express.static(config.app.publicDir, {
    etag: true,
    setHeaders: (res, filePath) => {
      // The vendored chart libraries are version-pinned and immutable.
      if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.use('/api', routes);

  // JSON 404 for unknown API paths (v2.0 fell through to the static handler).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown API route ${req.method} ${req.originalUrl}` });
  });

  // The error handler. Express 4 needs all four arguments here — the unused
  // `next` is what makes Express treat it as error middleware.
  app.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    logger.error('request failed', { method: req.method, path: req.originalUrl, status, err: err.message });
    if (res.headersSent) return;
    res.status(status).json({
      error: status === 500 ? 'Internal error' : err.message,
      path: req.originalUrl,
    });
  });

  return app;
}

module.exports = { createApp };
