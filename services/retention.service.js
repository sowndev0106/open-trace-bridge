const fs = require('fs');
const path = require('path');
const projects = require('../models/project.model');
const convs = require('../models/conversation.model');
const apicalls = require('../models/apicall.model');
const runs = require('../models/run.model');
const sessions = require('../models/session.model');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const INACTIVITY_CHECK_MS = 60 * 1000;        // check every 1 minute
const INACTIVITY_MINUTES = Number(process.env.CONVERSATION_INACTIVITY_MINUTES || 5);

function sqliteTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function cutoffFor(now, days) {
  return sqliteTimestamp(new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)));
}

function runRetentionCleanup(now = new Date()) {
  let projectsChecked = 0;
  let conversationsDeleted = 0;
  let apiCallsDeleted = 0;
  let runsDeleted = 0;
  const sessionsDeleted = sessions.deleteExpired();

  for (const project of projects.list()) {
    const days = Number(project.chat_retention_days);
    if (!Number.isInteger(days) || days <= 0) continue;
    projectsChecked += 1;
    const cutoff = cutoffFor(now, days);
    // Remove per-conversation Discord upload dirs before their rows disappear.
    const workspacesDir = process.env.OTB_WORKSPACES_DIR || 'workspaces';
    for (const row of convs.listOlderThan(project.id, cutoff)) {
      const dir = path.join(workspacesDir, project.slug, '.otb-uploads', String(row.id));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    conversationsDeleted += convs.deleteOlderThan(project.id, cutoff);
    apiCallsDeleted += apicalls.deleteOlderThan(project.id, cutoff);
    runsDeleted += runs.deleteOlderThan(project.id, cutoff);
  }

  return { projectsChecked, conversationsDeleted, apiCallsDeleted, runsDeleted, sessionsDeleted };
}

function startRetentionJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const timer = setInterval(() => {
    try {
      const result = runRetentionCleanup();
      if (result.conversationsDeleted || result.apiCallsDeleted || result.runsDeleted || result.sessionsDeleted) {
        console.log(`[retention] deleted conversations=${result.conversationsDeleted} apiCalls=${result.apiCallsDeleted} runs=${result.runsDeleted} sessions=${result.sessionsDeleted}`);
      }
    } catch (err) {
      console.error('[retention] cleanup failed:', err.message);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function startInactivityJob({ intervalMs = INACTIVITY_CHECK_MS, minutes = INACTIVITY_MINUTES } = {}) {
  const timer = setInterval(() => {
    try {
      const closed = convs.autoCloseInactive(minutes);
      if (closed > 0) {
        console.log(`[inactivity] auto-closed ${closed} conversation(s) inactive for >${minutes} minutes`);
      }
    } catch (err) {
      console.error('[inactivity] job failed:', err.message);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { runRetentionCleanup, startRetentionJob, startInactivityJob, cutoffFor };
