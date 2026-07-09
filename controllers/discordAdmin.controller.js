const bots = require('../models/discordBot.model');
const dmUsers = require('../models/discordUser.model');
const settings = require('../models/setting.model');
const projects = require('../models/project.model');
const discord = require('../services/discord.service');

const DIGITS_RE = /^\d{1,25}$/;

function renderPage(res, status, { errors = [] } = {}) {
  const statusById = new Map(discord.statusAll().map((s) => [s.id, s]));
  res.status(status).render('discord/index', {
    bots: bots.list().map((b) => ({ ...b, token: undefined, live: statusById.get(b.id) })),
    users: dmUsers.list().map((u) => ({ ...u, project_ids: dmUsers.listProjectIds(u.id) })),
    projects: projects.list(),
    allowedModels: settings.get('discord_allowed_models') || '',
    defaultModel: settings.get('discord_default_model') || '',
    errors,
  });
}

function page(req, res) { renderPage(res, 200); }

function createBot(req, res) {
  const name = String(req.body.name || '').trim();
  const token = String(req.body.token || '').trim();
  const errors = [];
  if (!name) errors.push('Bot name is required.');
  if (!token) errors.push('Bot token is required.');
  if (errors.length) return renderPage(res, 400, { errors });
  const b = bots.create({ name, token, enabled: 1 });
  discord.restartBot(b.id);
  return res.redirect('/admin/discord');
}

function updateBot(req, res) {
  const b = bots.findById(req.params.id);
  if (!b) return res.status(404).send('Bot not found');
  const name = String(req.body.name || '').trim();
  if (!name) return renderPage(res, 400, { errors: ['Bot name is required.'] });
  const fields = { name, enabled: req.body.enabled ? 1 : 0 };
  const token = String(req.body.token || '').trim();
  if (token) fields.token = token; // blank keeps the stored token
  bots.update(b.id, fields);
  discord.restartBot(b.id);
  return res.redirect('/admin/discord');
}

function deleteBot(req, res) {
  discord.stopBot(Number(req.params.id));
  bots.remove(req.params.id);
  res.redirect('/admin/discord');
}

function parseUserInput(body) {
  const errors = [];
  const label = String(body.label || '').trim();
  const role = body.role === 'admin' ? 'admin' : 'member';
  const all_projects = body.all_projects ? 1 : 0;
  const project_ids = [].concat(body.project_ids || []).map(Number).filter(Number.isInteger);
  return { errors, values: { label, role, all_projects, project_ids } };
}

function createUser(req, res) {
  const discord_user_id = String(req.body.discord_user_id || '').trim();
  const { errors, values } = parseUserInput(req.body);
  if (!DIGITS_RE.test(discord_user_id)) errors.push('Discord user id must be the numeric snowflake id.');
  if (dmUsers.findByDiscordId(discord_user_id)) errors.push('This Discord user is already allowlisted.');
  if (errors.length) return renderPage(res, 400, { errors });
  const u = dmUsers.create({ discord_user_id, label: values.label, role: values.role, all_projects: values.all_projects });
  dmUsers.setProjects(u.id, values.project_ids);
  return res.redirect('/admin/discord');
}

function updateUser(req, res) {
  const u = dmUsers.findById(req.params.id);
  if (!u) return res.status(404).send('User not found');
  const { errors, values } = parseUserInput(req.body);
  if (errors.length) return renderPage(res, 400, { errors });
  dmUsers.update(u.id, { label: values.label, role: values.role, all_projects: values.all_projects });
  dmUsers.setProjects(u.id, values.project_ids);
  return res.redirect('/admin/discord');
}

function deleteUser(req, res) {
  dmUsers.remove(req.params.id);
  res.redirect('/admin/discord');
}

function saveModels(req, res) {
  settings.set('discord_allowed_models', String(req.body.allowed_models || '').trim());
  settings.set('discord_default_model', String(req.body.default_model || '').trim());
  res.redirect('/admin/discord');
}

module.exports = { page, createBot, updateBot, deleteBot, createUser, updateUser, deleteUser, saveModels };
