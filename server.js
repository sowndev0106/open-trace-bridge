const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/admin', require('./routes/admin.routes'));
app.use('/api', require('./routes/events.routes'));
app.use('/internal', require('./routes/internal.routes'));

app.use((req, res) => {
  console.log('Unhandled route:', req.method, req.originalUrl);
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 6666;
if (require.main === module) {
  app.listen(PORT, () => console.log(`OpenTraceBridge server listening on port ${PORT}`));
}
module.exports = app;
