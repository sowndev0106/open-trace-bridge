const router = require('express').Router();
const ac = require('../controllers/auth.controller');

router.get('/login', ac.loginForm);
router.post('/login', ac.login);

module.exports = router;
