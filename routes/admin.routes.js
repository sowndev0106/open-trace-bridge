const router = require('express').Router();
const pc = require('../controllers/project.controller');
const cc = require('../controllers/conversation.controller');
const dc = require('../controllers/dashboard.controller');
const ac = require('../controllers/auth.controller');

router.post('/logout', ac.logout);
router.get('/', (req, res) => res.redirect('/admin/projects'));
router.get('/dashboard', dc.dashboard);
router.get('/projects', pc.listProjects);
router.get('/projects/new', pc.newProjectForm);
router.post('/projects', pc.createProject);
router.get('/projects/:id/edit', pc.editProjectForm);
router.post('/projects/:id', pc.updateProject);
router.post('/projects/:id/delete', pc.deleteProject);
router.post('/projects/:id/sync', pc.syncNow);
router.get('/projects/:id/sync-status', pc.syncStatus);
router.get('/projects/:id/conversations', cc.listForProject);
router.get('/conversations/:id', cc.detail);

const chat = require('../controllers/chat.controller');
router.get('/projects/:id/chat', chat.chatPage);
router.get('/projects/:id/opencode', chat.opencodePage);
router.post('/projects/:id/chat/messages', chat.postMessage);
router.post('/projects/:id/chat/new', chat.newConversation);

const discordAdmin = require('../controllers/discordAdmin.controller');
router.get('/discord', discordAdmin.page);
router.post('/discord/bots', discordAdmin.createBot);
router.post('/discord/bots/:id', discordAdmin.updateBot);
router.post('/discord/bots/:id/delete', discordAdmin.deleteBot);
router.post('/discord/users', discordAdmin.createUser);
router.post('/discord/users/:id', discordAdmin.updateUser);
router.post('/discord/users/:id/delete', discordAdmin.deleteUser);
router.post('/discord/models', discordAdmin.saveModels);

module.exports = router;
