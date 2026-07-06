const projects = require('../models/project.model');
const runs = require('../models/run.model');
const { getDb } = require('../lib/db');

const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_DAYS = [7, 30, 90];

function cutoffIso(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
}

function questionsPerDay(projectIds, cutoff) {
  if (!projectIds.length) return [];
  const placeholders = projectIds.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT date(m.created_at) AS day, COUNT(*) AS count
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'in' AND c.project_id IN (${placeholders}) AND m.created_at >= datetime(?)
     GROUP BY day ORDER BY day`
  ).all(...projectIds, cutoff);
}

function questionsCountForProject(projectId, cutoff) {
  return getDb().prepare(
    `SELECT COUNT(*) AS count FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'in' AND c.project_id = ? AND m.created_at >= datetime(?)`
  ).get(projectId, cutoff).count;
}

function apiCallStatsForProject(projectId, cutoff) {
  const rows = getDb().prepare(
    `SELECT status, error FROM api_calls WHERE project_id = ? AND created_at >= datetime(?)`
  ).all(projectId, cutoff);
  const errorCount = rows.filter((r) => r.error || (r.status && r.status >= 400)).length;
  return { total: rows.length, errorCount };
}

function dashboard(req, res) {
  const days = ALLOWED_DAYS.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const cutoff = cutoffIso(days);
  const filterProjectId = req.query.project ? Number(req.query.project) : null;

  const allProjects = projects.list();
  const scoped = filterProjectId ? allProjects.filter((p) => p.id === filterProjectId) : allProjects;

  const perProject = scoped.map((p) => {
    const stats = runs.statsForProject(p.id, cutoff);
    const apiStats = apiCallStatsForProject(p.id, cutoff);
    return {
      project: p,
      questions: questionsCountForProject(p.id, cutoff),
      ...stats,
      apiCallCount: apiStats.total,
      apiCallErrorCount: apiStats.errorCount,
    };
  });

  const totals = perProject.reduce((acc, row) => ({
    questions: acc.questions + row.questions,
    apiCallCount: acc.apiCallCount + row.apiCallCount,
    totalCostUsd: acc.totalCostUsd + (row.totalCostUsd || 0),
    totalTokensInput: acc.totalTokensInput + (row.totalTokensInput || 0),
    totalTokensOutput: acc.totalTokensOutput + (row.totalTokensOutput || 0),
    totalRuns: acc.totalRuns + row.totalRuns,
    errorRuns: acc.errorRuns + Math.round((row.errorRate || 0) * row.totalRuns),
  }), { questions: 0, apiCallCount: 0, totalCostUsd: 0, totalTokensInput: 0, totalTokensOutput: 0, totalRuns: 0, errorRuns: 0 });

  const chart = questionsPerDay(scoped.map((p) => p.id), cutoff);

  res.render('dashboard/index', {
    days, allProjects, perProject, totals, chart, filterProjectId,
  });
}

module.exports = { dashboard };
