const router = require('express').Router();
const pc = require('../controllers/project.controller');

router.get('/', (req, res) => res.redirect('/admin/projects'));
router.get('/projects', pc.listProjects);
router.get('/projects/new', pc.newProjectForm);
router.post('/projects', pc.createProject);
router.get('/projects/:id/edit', pc.editProjectForm);
router.post('/projects/:id', pc.updateProject);
router.post('/projects/:id/delete', pc.deleteProject);

module.exports = router;
