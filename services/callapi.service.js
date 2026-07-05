const apis = require('../models/api.model');
const apicalls = require('../models/apicall.model');

async function executeApiCall({ project, groupName, method, path: apiPath, params }) {
  const group = apis.findByProjectAndName(project.id, groupName);
  if (!group) throw new Error(`API group "${groupName}" does not exist in project ${project.slug}`);

  const m = String(method || 'GET').toUpperCase();
  const allowed = group.allowed_methods.split(',').map((s) => s.trim().toUpperCase());
  if (!allowed.includes(m)) throw new Error(`Method ${m} is not allowed (allowed: ${group.allowed_methods})`);

  const base = group.base_url.replace(/\/$/, '');
  const rawPath = String(apiPath || '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
    throw new Error(`Path must be relative, not an absolute URL outside the configured base URL`);
  }
  const url = new URL(base + '/' + rawPath.replace(/^\//, ''));
  if (!url.href.startsWith(base)) throw new Error(`Path escapes the configured base URL`);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }

  const headers = { accept: 'application/json' };
  if (group.api_key) headers[group.auth_header.toLowerCase()] = group.api_key;

  let status = null;
  try {
    const resp = await fetch(url.href, { method: m, headers, signal: AbortSignal.timeout(30000) });
    status = resp.status;
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status, body };
  } finally {
    apicalls.add({ project_id: project.id, group_name: groupName, method: m, url: url.href, status });
  }
}

module.exports = { executeApiCall };
