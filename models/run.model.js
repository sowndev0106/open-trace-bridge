const { getDb } = require('../lib/db');

function add({ project_id, conversation_id, status, duration_ms, tokens_input, tokens_output, tokens_reasoning, cost_usd, error }) {
  getDb().prepare(
    `INSERT INTO runs (project_id, conversation_id, status, duration_ms, tokens_input, tokens_output, tokens_reasoning, cost_usd, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(project_id, conversation_id ?? null, status, duration_ms ?? null,
    tokens_input ?? null, tokens_output ?? null, tokens_reasoning ?? null, cost_usd ?? null, error ?? null);
}

function listByProject(project_id) {
  return getDb().prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC').all(project_id);
}

function deleteOlderThan(project_id, cutoff) {
  const info = getDb().prepare(
    `DELETE FROM runs WHERE project_id = ? AND created_at < datetime(?)`
  ).run(project_id, cutoff);
  return info.changes;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(idx, 0)];
}

function statsForProject(project_id, cutoffIso) {
  const rows = getDb().prepare(
    `SELECT status, duration_ms, tokens_input, tokens_output, tokens_reasoning, cost_usd
     FROM runs WHERE project_id = ? AND created_at >= datetime(?)`
  ).all(project_id, cutoffIso);

  const totalRuns = rows.length;
  if (!totalRuns) {
    return {
      totalRuns: 0, avgDurationMs: null, p95DurationMs: null, errorRate: null,
      totalTokensInput: null, totalTokensOutput: null, totalTokensReasoning: null, totalCostUsd: null,
    };
  }

  const durations = rows.map((r) => r.duration_ms).filter((d) => d != null).sort((a, b) => a - b);
  const errorCount = rows.filter((r) => r.status === 'error' || r.status === 'timeout').length;

  const sumOrNull = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  return {
    totalRuns,
    avgDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    p95DurationMs: percentile(durations, 0.95),
    errorRate: errorCount / totalRuns,
    totalTokensInput: sumOrNull('tokens_input'),
    totalTokensOutput: sumOrNull('tokens_output'),
    totalTokensReasoning: sumOrNull('tokens_reasoning'),
    totalCostUsd: sumOrNull('cost_usd'),
  };
}

function statsForConversation(conversation_id) {
  return getDb().prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_input),0) AS tokens_input,
            COALESCE(SUM(tokens_output),0) AS tokens_output, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM runs WHERE conversation_id = ?`
  ).get(conversation_id);
}
// Named totalsForProject (not statsForProject) to avoid colliding with the existing
// cutoff-windowed statsForProject(project_id, cutoffIso) above, which
// controllers/dashboard.controller.js and tests/models.test.js already depend on.
function totalsForProject(project_id) {
  return getDb().prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_input),0) AS tokens_input,
            COALESCE(SUM(tokens_output),0) AS tokens_output, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM runs WHERE project_id = ?`
  ).get(project_id);
}

module.exports = {
  add, listByProject, deleteOlderThan, statsForProject,
  statsForConversation, totalsForProject,
};
