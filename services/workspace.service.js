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
- Gọi qua MCP tool \`call_api\` với \`group: "${g.name}"\`. KHÔNG cần API key — server tự gắn.

${g.description_md}
`).join('\n');

  return `# ${project.name} — Incident Investigator

${project.system_prompt}

# Quy tắc

- Bạn CHỈ được đọc source code trong workspace này và gọi các API qua MCP tool \`call_api\`.
- Không sửa code, không chạy lệnh shell, không truy cập URL ngoài danh sách API bên dưới.
- Khi phân tích xong, trả lời NGẮN GỌN bằng markdown theo cấu trúc heading:
  **Tóm tắt** (1-3 dòng), **Kết luận**, **Evidence** (bullet list), **Bước tiếp theo** (bullet list).
- Code snippet: LUÔN ghi file path trước block, chỉ trích đoạn quan trọng (< 80 dòng), dùng fenced code block \`\`\`<language>.
- Data/log/JSON: hiển thị key fields quan trọng trước, raw excerpt sau, truncate nếu dài.
- TUYỆT ĐỐI không đưa secret, token, API key, private key, password vào câu trả lời.

# Các API có thể gọi (qua tool call_api(group, method, path, params))
${apiSections || '\n(Chưa khai báo API nào)'}
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
          OTB_BASE: `http://127.0.0.1:${process.env.PORT || 6666}`,
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
      throw new Error(`Git fail cho repo ${repo.git_url}: ${err.stderr || err.message}`);
    }
  }

  fs.writeFileSync(path.join(ws, 'AGENTS.md'), buildAgentsMd(project, apiGroups));
  fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify(buildOpencodeConfig(project), null, 2));
  return ws;
}

module.exports = { buildAgentsMd, buildOpencodeConfig, getInternalToken, ensureWorkspace, repoDirName };
