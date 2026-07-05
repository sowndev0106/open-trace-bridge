const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');

function listProjects(req, res) {
  res.render('projects/list', { projects: projects.list() });
}
function newProjectForm(req, res) {
  res.render('projects/form', { project: null, repos: [], apis: [], error: null });
}
function createProject(req, res) {
  const { slug, name, keyword, system_prompt, teams_webhook_url } = req.body;
  if (!slug || !name) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: 'slug và name là bắt buộc',
    });
  }
  if (projects.findBySlug(slug)) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: `slug "${slug}" đã tồn tại`,
    });
  }
  const p = projects.create({ slug, name, keyword, system_prompt, teams_webhook_url });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function editProjectForm(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  res.render('projects/form', {
    project: p, repos: repos.listByProject(p.id), apis: apis.listByProject(p.id), error: null,
  });
}
function updateProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { slug, name, keyword, system_prompt, teams_webhook_url } = req.body;
  projects.update(p.id, { slug, name, keyword, system_prompt, teams_webhook_url });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteProject(req, res) {
  projects.remove(req.params.id);
  res.redirect('/admin/projects');
}

module.exports = { listProjects, newProjectForm, createProject, editProjectForm, updateProject, deleteProject };
