// Orchestrates repo syncs per project: background trigger with a per-project
// mutex, inline fallback for the message path, and derived status for the UI.
const fs = require('fs');
const path = require('path');
const projects = require('../models/project.model');
const repos = require('../models/repo.model');
const apis = require('../models/api.model');
const workspace = require('./workspace.service');

const running = new Map(); // projectId -> { rerun: boolean }

function deriveProjectStatus(repoRows) {
  const statuses = new Set(repoRows.map((r) => r.sync_status));
  if (statuses.has('error')) return 'error';
  if (statuses.has('syncing')) return 'syncing';
  if (statuses.has('pending')) return 'pending';
  return 'success';
}

async function syncProject(projectId) {
  const project = projects.findById(projectId);
  if (!project) throw new Error(`Project ${projectId} does not exist`);
  const repoRows = repos.listByProject(projectId);
  const ws = workspace.workspacePathFor(project);
  const results = [];
  for (const repo of repoRows) repos.setSyncStatus(repo.id, { status: 'syncing' });
  for (const repo of repoRows) {
    try {
      await workspace.syncRepo(repo, ws);
      repos.setSyncStatus(repo.id, { status: 'success' });
      results.push({ repoId: repo.id, git_url: repo.git_url, status: 'success' });
    } catch (err) {
      repos.setSyncStatus(repo.id, { status: 'error', error: err.message });
      results.push({ repoId: repo.id, git_url: repo.git_url, status: 'error', error: err.message });
    }
  }
  workspace.pruneRemovedRepos(ws, repoRows);
  workspace.writeWorkspaceFiles(project, apis.listByProject(projectId));
  return { ok: results.every((r) => r.status === 'success'), results };
}

// Fire-and-forget background sync. A trigger that lands while a sync for the
// same project is running coalesces into exactly one rerun after it finishes.
// Returns the loop promise so tests can await it; production callers ignore it.
function triggerSync(projectId, { reason = 'save' } = {}) {
  const id = Number(projectId);
  const state = running.get(id);
  if (state) { state.rerun = true; return Promise.resolve(); }
  running.set(id, { rerun: false });
  return (async () => {
    do {
      running.get(id).rerun = false;
      try {
        await syncProject(id);
      } catch (err) {
        console.error(`Sync fail (project=${id}, reason=${reason}):`, err.message);
      }
    } while (running.get(id).rerun);
    running.delete(id);
  })();
}

// Message path: no git when the workspace is ready; inline force-sync as a
// fallback so a question never fails just because nobody pressed Save.
async function ensureReady(project) {
  const repoRows = repos.listByProject(project.id);
  const ws = workspace.workspacePathFor(project);
  const ready = repoRows.every((r) => r.sync_status === 'success'
    && fs.existsSync(path.join(ws, workspace.repoDirName(r.git_url))));
  if (repoRows.length && !ready) {
    const { ok, results } = await syncProject(project.id);
    if (!ok) {
      const failed = results.filter((r) => r.status === 'error')
        .map((r) => `${r.git_url}: ${r.error}`).join('; ');
      throw new Error(`Source sync failed: ${failed}`);
    }
    return ws; // syncProject already wrote the workspace files
  }
  return workspace.writeWorkspaceFiles(project, apis.listByProject(project.id));
}

module.exports = { syncProject, triggerSync, ensureReady, deriveProjectStatus };
