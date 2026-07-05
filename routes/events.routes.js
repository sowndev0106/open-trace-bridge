const router = require('express').Router();
const ec = require('../controllers/event.controller');

router.get('/events/:slug', ec.handleEvent);
router.post('/events/:slug', ec.handleEvent);
// Route cũ (Step 1) — giữ để Power Automate cũ không lỗi, nhắc đổi URL
router.all('/events', (req, res) => {
  res.status(200).json({
    handled: false,
    reply: 'URL này đã đổi. Dùng /api/events/<project-slug> — tạo project tại /admin/projects.',
  });
});

module.exports = router;
