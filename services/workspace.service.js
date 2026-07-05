const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const WORKSPACES_DIR = process.env.OTB_WORKSPACES_DIR || path.join(process.cwd(), 'workspaces');
const DATA_DIR = path.join(process.cwd(), 'data');

function getInternalToken() {
  const f = path.join(DATA_DIR, 'internal-token');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(f, 'utf8').trim();
}

function repoDirName(gitUrl) {
  return gitUrl.split('/').pop().replace(/\.git$/, '').replace(/[^\w.-]/g, '_');
}

function buildAgentsMd(project, apiGroups) {
  const apiSections = apiGroups.map((g) => `
## API group: ${g.name}

- Base URL: \`${g.base_url}\`
- Allowed methods: ${g.allowed_methods}
- Call through MCP tool \`call_api\` with \`group: "${g.name}"\`. Do not provide an API key; the server attaches it.

${g.description_md}
`).join('\n');

  return `# ${project.name} — Incident Investigator

${project.system_prompt}

# Rules

- You may ONLY read source code in this workspace and call APIs through the MCP tool \`call_api\`.
- Do not edit code, run shell commands, or access URLs outside the API list below.
- When the investigation is complete, answer CONCISELY in markdown with these headings:
  **Summary** (1-3 lines), **Conclusion**, **Evidence** (bullet list), **Next steps** (bullet list).
- Code snippets: always include the file path before the block, quote only the important excerpt (< 80 lines), and use a fenced code block \`\`\`<language>.
- Data/log/JSON: show important key fields first, then a raw excerpt, and truncate long output.
- Never include secrets, tokens, API keys, private keys, or passwords in the answer.

# Callable APIs (through call_api(group, method, path, params))
${apiSections || '\n(No APIs have been configured)'}
`;
}

function buildOpencodeConfig(project) {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    mcp: {
      otb: {
        type: 'local',
        command: ['node', path.join(__dirname, '..', 'mcp', 'callapi-stdio.js')],
        enabled: true,
        environment: {
          OTB_PROJECT_SLUG: project.slug,
          // /internal/call-api is served by the private admin app, not the public tunnel.
          OTB_BASE: `http://127.0.0.1:${process.env.ADMIN_PORT || 8667}`,
          OTB_INTERNAL_TOKEN: getInternalToken(),
        },
      },
    },
  };
}

function gitEnvFor(repo, keyFile) {
  if (repo.auth_type === 'ssh' && repo.ssh_key) {
    fs.writeFileSync(keyFile, repo.ssh_key.trim() + '\n', { mode: 0o600 });
    return { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyFile} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes` };
  }
  return { ...process.env };
}

function cloneUrlFor(repo) {
  if (repo.auth_type === 'https-token' && repo.token) {
    return repo.git_url.replace(/^https:\/\//, `https://x-access-token:${repo.token}@`);
  }
  return repo.git_url;
}

async function ensureWorkspace(project, repoRows, apiGroups) {
  const ws = path.join(WORKSPACES_DIR, project.slug);
  const keysDir = path.join(WORKSPACES_DIR, '.keys');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });

  for (const repo of repoRows) {
    const dir = path.join(ws, repoDirName(repo.git_url));
    const keyFile = path.join(keysDir, `repo-${repo.id}`);
    const env = gitEnvFor(repo, keyFile);
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        await execFileP('git', ['-C', dir, 'pull', '--ff-only'], { env, timeout: 120000 });
      } else {
        await execFileP('git', ['clone', '--depth', '1', '--branch', repo.branch || 'main',
          cloneUrlFor(repo), dir], { env, timeout: 300000 });
      }
    } catch (err) {
      throw new Error(`Git failed for repo ${repo.git_url}: ${err.stderr || err.message}`);
    }
  }

  fs.writeFileSync(path.join(ws, 'AGENTS.md'), buildAgentsMd(project, apiGroups));
  fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify(buildOpencodeConfig(project), null, 2));
  return ws;
}

module.exports = { buildAgentsMd, buildOpencodeConfig, getInternalToken, ensureWorkspace, repoDirName };
