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
  const { slug, name, keyword, system_prompt, teams_webhook_url, max_msg_length } = req.body;
  if (!slug || !name) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: 'slug và name là bắt buộc',
    });
  }
  if (!(Number(max_msg_length) > 0)) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: 'max_msg_length là bắt buộc và phải là số dương',
    });
  }
  if (projects.findBySlug(slug)) {
    return res.status(400).render('projects/form', {
      project: req.body, repos: [], apis: [], error: `slug "${slug}" đã tồn tại`,
    });
  }
  const p = projects.create({ slug, name, keyword, system_prompt, teams_webhook_url, max_msg_length });
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
  const { slug, name, keyword, system_prompt, teams_webhook_url, max_msg_length } = req.body;
  projects.update(p.id, {
    slug, name, keyword, system_prompt, teams_webhook_url,
    max_msg_length: Number(max_msg_length) > 0 ? Number(max_msg_length) : p.max_msg_length,
  });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteProject(req, res) {
  projects.remove(req.params.id);
  res.redirect('/admin/projects');
}

function addRepo(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { git_url, auth_type, token, ssh_key, branch } = req.body;
  if (git_url) repos.create({ project_id: p.id, git_url, auth_type, token, ssh_key, branch });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteRepo(req, res) {
  repos.remove(req.params.repoId);
  res.redirect(`/admin/projects/${req.params.id}/edit`);
}
function addApiGroup(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { name, base_url, api_key, auth_header, allowed_methods, description_md } = req.body;
  if (name && base_url) {
    apis.create({ project_id: p.id, name, base_url, api_key, auth_header, allowed_methods, description_md });
  }
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteApiGroup(req, res) {
  apis.remove(req.params.apiId);
  res.redirect(`/admin/projects/${req.params.id}/edit`);
}

module.exports = {
  listProjects, newProjectForm, createProject, editProjectForm, updateProject, deleteProject,
  addRepo, deleteRepo, addApiGroup, deleteApiGroup,
};
