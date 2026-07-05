const express = require('express');
const path = require('path');

function logger(req, res, next) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
}
function notFound(req, res) {
  console.log('Unhandled route:', req.method, req.originalUrl);
  res.status(404).json({ error: 'Not found' });
}

// ── Public app (tunnel ra internet): CHỈ event API ──────────────────────────
const publicApp = express();
publicApp.use(express.json({ limit: '1mb' }));
publicApp.use(express.urlencoded({ extended: true }));
publicApp.use(logger);
publicApp.get('/health', (req, res) => res.json({ status: 'ok' }));
publicApp.use('/api', require('./routes/events.routes'));
publicApp.use(notFound);

// ── Admin app (private, KHÔNG tunnel): dashboard + internal call-api ────────
const adminApp = express();
adminApp.use(express.json({ limit: '1mb' }));
adminApp.use(express.urlencoded({ extended: true }));
adminApp.set('view engine', 'ejs');
adminApp.set('views', path.join(__dirname, 'views'));
adminApp.use(logger);
adminApp.get('/health', (req, res) => res.json({ status: 'ok', scope: 'admin' }));
adminApp.get('/', (req, res) => res.redirect('/admin/projects'));
adminApp.use('/admin', require('./routes/admin.routes'));
adminApp.use('/internal', require('./routes/internal.routes'));
adminApp.use(notFound);

const PORT = process.env.PORT || 6666;
const ADMIN_PORT = process.env.ADMIN_PORT || 6667;
if (require.main === module) {
  publicApp.listen(PORT, () => console.log(`OpenTraceBridge public API listening on port ${PORT}`));
  adminApp.listen(ADMIN_PORT, () => console.log(`OpenTraceBridge admin UI listening on port ${ADMIN_PORT} (private)`));
}
module.exports = { publicApp, adminApp };
