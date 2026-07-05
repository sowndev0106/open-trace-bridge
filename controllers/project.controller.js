const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const apicalls = require('../models/apicall.model');
const {
  validateProjectInput,
  validateRepoInput,
  validateApiGroupInput,
} = require('../services/adminValidation');
const sync = require('../services/sync.service');

function renderProjectForm(res, status, { project, repoRows, apiRows, errors = [], repoDraft = null, apiDraft = null, apiCalls = [] }) {
  return res.status(status).render('projects/form', {
    project,
    repos: repoRows || [],
    apis: apiRows || [],
    apiCalls,
    errors,
    error: errors[0] || null,
    repoDraft,
    apiDraft,
  });
}

function listProjects(req, res) {
  const rows = projects.list().map((p) => {
    const repoRows = repos.listByProject(p.id);
    return {
      ...p,
      repo_count: repoRows.length,
      sync_status: sync.deriveProjectStatus(repoRows),
      synced_at: repoRows.map((r) => r.synced_at).filter(Boolean).sort().pop() || null,
    };
  });
  res.render('projects/list', { projects: rows });
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
  sync.triggerSync(p.id, { reason: 'create' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function editProjectForm(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  return renderProjectForm(res, 200, {
    project: p,
    repoRows: repos.listByProject(p.id),
    apiRows: apis.listByProject(p.id),
    apiCalls: apicalls.listByProject(p.id).slice(0, 25),
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
      apiCalls: apicalls.listByProject(p.id).slice(0, 25),
      errors,
    });
  }
  projects.update(p.id, values);
  sync.triggerSync(p.id, { reason: 'update' });
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
      apiCalls: apicalls.listByProject(p.id).slice(0, 25),
      errors,
      repoDraft: values,
    });
  }
  repos.create({ project_id: p.id, ...values });
  sync.triggerSync(p.id, { reason: 'repo-add' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function deleteRepo(req, res) {
  repos.remove(req.params.repoId);
  sync.triggerSync(req.params.id, { reason: 'repo-delete' });
  res.redirect(`/admin/projects/${req.params.id}/edit`);
}
function syncNow(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  sync.triggerSync(p.id, { reason: 'manual' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}
function syncStatus(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const repoRows = repos.listByProject(p.id);
  res.json({
    project: sync.deriveProjectStatus(repoRows),
    repos: repoRows.map((r) => ({
      id: r.id, git_url: r.git_url, sync_status: r.sync_status,
      sync_error: r.sync_error, synced_at: r.synced_at,
    })),
  });
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
      apiCalls: apicalls.listByProject(p.id).slice(0, 25),
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
  addRepo, deleteRepo, addApiGroup, deleteApiGroup, syncNow, syncStatus,
};
