const { getDb } = require('../lib/db');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const discordChannels = require('../models/discordChannel.model');
const discordBots = require('../models/discordBot.model');
const { validateProjectBundle, validateDiscordSection } = require('../services/adminValidation');
const sync = require('../services/sync.service');

function renderProjectForm(res, status, { project, repoRows, apiRows, errors = [], discordChannels: discordChannelRows = [] }) {
  return res.status(status).render('projects/form', {
    project,
    repos: repoRows || [],
    apis: apiRows || [],
    errors,
    error: errors[0] || null,
    discordBots: discordBots.list().map((b) => ({ id: b.id, name: b.name })),
    discordChannels: discordChannelRows,
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

// Insert/update submitted rows, delete rows the submission no longer contains.
function reconcileRows(model, projectId, submitted) {
  const submittedIds = new Set(submitted.filter((r) => r.id).map((r) => r.id));
  for (const existing of model.listByProject(projectId)) {
    if (!submittedIds.has(existing.id)) model.remove(existing.id);
  }
  for (const row of submitted) {
    const { id, ...values } = row;
    if (id) model.update(id, values);
    else model.create({ project_id: projectId, ...values });
  }
}

function createProject(req, res) {
  const { values, errors } = validateProjectBundle(req.body);
  if (values.project.slug && projects.findBySlug(values.project.slug)) {
    errors.push(`Slug "${values.project.slug}" already exists.`);
  }
  const discord = validateDiscordSection(req.body);
  errors.push(...discord.errors);
  for (const row of discord.values.channels) {
    if (discordChannels.findByChannelId(row.channel_id)) {
      errors.push(`Discord channel ${row.channel_id} is already bound to another project.`);
    }
  }
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: { ...req.body, ...values.project },
      repoRows: values.repos,
      apiRows: values.apis,
      errors,
      discordChannels: discord.values.channels,
    });
  }
  const p = getDb().transaction(() => {
    const created = projects.create(values.project);
    reconcileRows(repos, created.id, values.repos);
    reconcileRows(apis, created.id, values.apis);
    projects.update(created.id, { discord_bot_id: discord.values.discord_bot_id });
    discordChannels.replaceForProject(created.id, discord.values.channels);
    return created;
  })();
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
    discordChannels: discordChannels.listByProject(p.id),
  });
}

function updateProject(req, res) {
  const p = projects.findById(req.params.id);
  if (!p) return res.status(404).send('Project not found');
  const existingRepos = repos.listByProject(p.id);
  const existingApis = apis.listByProject(p.id);
  const { values, errors } = validateProjectBundle(req.body, { existingRepos, existingApis });
  const existing = values.project.slug ? projects.findBySlug(values.project.slug) : null;
  if (existing && Number(existing.id) !== Number(p.id)) {
    errors.push(`Slug "${values.project.slug}" already exists.`);
  }
  const discord = validateDiscordSection(req.body);
  errors.push(...discord.errors);
  for (const row of discord.values.channels) {
    const existingChannel = discordChannels.findByChannelId(row.channel_id);
    if (existingChannel && Number(existingChannel.project_id) !== Number(p.id)) {
      errors.push(`Discord channel ${row.channel_id} is already bound to another project.`);
    }
  }
  if (errors.length) {
    return renderProjectForm(res, 400, {
      project: { ...p, ...req.body, ...values.project, id: p.id },
      repoRows: values.repos,
      apiRows: values.apis,
      errors,
      discordChannels: discord.values.channels,
    });
  }
  getDb().transaction(() => {
    projects.update(p.id, { ...values.project, discord_bot_id: discord.values.discord_bot_id });
    reconcileRows(repos, p.id, values.repos);
    reconcileRows(apis, p.id, values.apis);
    discordChannels.replaceForProject(p.id, discord.values.channels);
  })();
  sync.triggerSync(p.id, { reason: 'update' });
  res.redirect(`/admin/projects/${p.id}/edit`);
}

function deleteProject(req, res) {
  projects.remove(req.params.id);
  res.redirect('/admin/projects');
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

module.exports = {
  listProjects, newProjectForm, createProject, editProjectForm, updateProject, deleteProject,
  syncNow, syncStatus,
};
