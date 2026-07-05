const PROJECT_SLUG_RE = /^[a-z0-9-]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const AUTH_TYPES = new Set(['none', 'https-token', 'ssh']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const { parseCurlApiGroupInput } = require('./curlApiGroup.service');

function clean(value) {
  return String(value ?? '').trim();
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpsGitUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isSshGitUrl(value) {
  return /^git@[^:]+:.+/.test(value);
}

function normalizeMethods(value) {
  return clean(value)
    .split(',')
    .map((method) => method.trim().toUpperCase())
    .filter(Boolean);
}

function validateProjectInput(input) {
  const values = {
    slug: clean(input.slug),
    name: clean(input.name),
    keyword: clean(input.keyword),
    system_prompt: String(input.system_prompt ?? ''),
    teams_webhook_url: clean(input.teams_webhook_url),
    max_msg_length: clean(input.max_msg_length),
  };
  const errors = [];
  const maxLength = Number(values.max_msg_length);

  if (!values.slug) {
    errors.push('Slug is required.');
  } else if (!PROJECT_SLUG_RE.test(values.slug)) {
    errors.push('Slug must use lowercase letters, numbers, and hyphens only.');
  }

  if (!values.name) errors.push('Name is required.');

  if (values.keyword && !TOKEN_RE.test(values.keyword)) {
    errors.push('Keyword must use letters, numbers, underscores, and hyphens only.');
  }

  if (values.teams_webhook_url && !isHttpUrl(values.teams_webhook_url)) {
    errors.push('Teams webhook URL must be a valid http or https URL.');
  }

  if (!Number.isInteger(maxLength)) {
    errors.push('Max message length is required and must be a whole number.');
  } else if (maxLength < 500) {
    errors.push('Max message length must be at least 500.');
  }

  return {
    values: { ...values, max_msg_length: Number.isInteger(maxLength) ? maxLength : values.max_msg_length },
    errors,
  };
}

function validateRepoInput(input) {
  const values = {
    git_url: clean(input.git_url),
    auth_type: clean(input.auth_type) || 'none',
    token: String(input.token ?? ''),
    ssh_key: String(input.ssh_key ?? ''),
    branch: clean(input.branch),
  };
  const errors = [];

  if (!values.git_url) {
    errors.push('Git URL is required.');
  } else if (!isHttpsGitUrl(values.git_url) && !isSshGitUrl(values.git_url)) {
    errors.push('Git URL must be an HTTPS URL or an SSH Git URL.');
  }

  if (!AUTH_TYPES.has(values.auth_type)) errors.push('Auth type is invalid.');
  if (!values.branch) errors.push('Branch is required.');
  if (values.auth_type === 'https-token' && !clean(values.token)) {
    errors.push('Token is required for https-token repositories.');
  }
  if (values.auth_type === 'ssh' && !clean(values.ssh_key)) {
    errors.push('SSH private key is required for ssh repositories.');
  }

  return { values, errors };
}

function validateApiGroupInput(input) {
  const errors = [];

  if (clean(input.curl_command)) {
    try {
      const parsed = parseCurlApiGroupInput(input);
      const methods = normalizeMethods(parsed.allowed_methods || 'GET');
      if (!methods.length || methods.some((method) => !ALLOWED_METHODS.has(method))) {
        errors.push('Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.');
      }
      return {
        values: { ...parsed, allowed_methods: methods.join(',') },
        errors,
      };
    } catch (err) {
      return {
        values: {
          name: clean(input.name),
          base_url: '',
          api_key: '',
          auth_header: 'Authorization',
          allowed_methods: 'GET',
          description_md: String(input.description_md ?? ''),
          curl_command: String(input.curl_command ?? ''),
        },
        errors: [err.message],
      };
    }
  }

  const methods = normalizeMethods(input.allowed_methods || 'GET');
  const values = {
    name: clean(input.name),
    base_url: clean(input.base_url),
    api_key: String(input.api_key ?? ''),
    auth_header: clean(input.auth_header),
    allowed_methods: methods.join(','),
    description_md: String(input.description_md ?? ''),
  };

  if (!values.name) {
    errors.push('API group name is required.');
  } else if (!TOKEN_RE.test(values.name)) {
    errors.push('API group name must use letters, numbers, underscores, and hyphens only.');
  }

  if (!values.base_url) {
    errors.push('Base URL is required.');
  } else if (!isHttpUrl(values.base_url)) {
    errors.push('Base URL must be a valid http or https URL.');
  }

  if (!values.auth_header) errors.push('Auth header is required.');
  if (!methods.length || methods.some((method) => !ALLOWED_METHODS.has(method))) {
    errors.push('Allowed methods can only include GET, POST, PUT, PATCH, and DELETE.');
  }

  return { values, errors };
}

module.exports = { validateProjectInput, validateRepoInput, validateApiGroupInput };
