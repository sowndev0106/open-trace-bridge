const router = require('express').Router();
const ec = require('../controllers/event.controller');

router.get('/events/:slug', ec.handleEvent);
router.post('/events/:slug', ec.handleEvent);
// Legacy Step 1 route. Keep it so old Power Automate flows do not fail; tell users to move to project URLs.
router.all('/events', (req, res) => {
  res.status(200).json({
    handled: false,
    reply: 'This URL has changed. Use /api/events/<project-slug> and create projects at /admin/projects.',
  });
});

module.exports = router;
