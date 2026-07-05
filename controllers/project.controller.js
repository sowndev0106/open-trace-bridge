const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const {
  validateProjectInput,
  validateRepoInput,
  validateApiGroupInput,
} = require('../services/adminValidation');

function renderProjectForm(res, status, { project, repoRows, apiRows, errors = [], repoDraft = null, apiDraft = null }) {
  return res.status(status).render('projects/form', {
    project,
    repos: repoRows || [],
    apis: apiRows || [],
    errors,
    error: errors[0] || null,
    repoDraft,
    apiDraft,
  });
}

function listProjects(req, res) {
  res.render('projects/list', { projects: projects.list() });
}
function newProjectForm(req, res) {
  renderProjectForm(res, 200, { project: null, repoRows: [], apiRows: [] });
}
function createProject(req, res) {
  const { values, errors } = validateProjectInput(req.body);
  if (values.slug && projects.findBySlug(values.slug)) {
    errors.push(`Slug "${values.slug}" already exists.`);
  }
  if (errors.length) {
    return renderProjectForm(res, 400, { project: { ...req.body, ...values }, repoRows: [], apiRows: [], errors });
  }
  const p = projects.create(values);
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function editProjectForm(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  return renderProjectForm(res, 200, {
    project: p,
    repoRows: repos.listByProject(p.id),
    apiRows: apis.listByProject(p.id),
  });
}
function updateProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { values, errors } = validateProjectInput(req.body);
  const existing = values.slug ? projects.findBySlug(values.slug) : null;
  if (existing && Number(existing.id) !== Number(p.id)) {
    errors.push(`Slug "${values.slug}" already exists.`);
  }
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: { ...p, ...req.body, ...values, id: p.id },
      repoRows: repos.listByProject(p.id),
      apiRows: apis.listByProject(p.id),
      errors,
    });
  }
  projects.update(p.id, values);
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteProject(req, res) {
  projects.remove(req.params.id);
  res.redirect('/admin/projects');
}

function addRepo(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { values, errors } = validateRepoInput(req.body);
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: p,
      repoRows: repos.listByProject(p.id),
      apiRows: apis.listByProject(p.id),
      errors,
      repoDraft: values,
    });
  }
  repos.create({ project_id: p.id, ...values });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteRepo(req, res) {
  repos.remove(req.params.repoId);
  res.redirect(`/admin/projects/${req.params.id}/edit`);
}
function addApiGroup(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const { values, errors } = validateApiGroupInput(req.body);
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: p,
      repoRows: repos.listByProject(p.id),
      apiRows: apis.listByProject(p.id),
      errors,
      apiDraft: values,
    });
  }
  apis.create({ project_id: p.id, ...values });
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
