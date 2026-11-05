import { spawnSync } from 'node:child_process';

export class GhError extends Error {
  constructor(message, { status = null, data = null } = {}) {
    super(message);
    this.name = 'GhError';
    this.status = status;
    this.data = data;
  }
}

function parseJson(text) {
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeFailure(stderr, data) {
  const parts = [stderr.trim().replace(/^gh: /, '')];
  if (Array.isArray(data?.errors)) {
    parts.push(...data.errors.map((error) => error?.message ?? JSON.stringify(error)));
  }
  return parts.filter(Boolean).join(' | ') || 'gh api failed';
}

// Every call goes through `gh api` with the body on stdin, so untrusted values
// never reach a shell and the same code works with local `gh auth` or a token.
export function createGhClient({ token, spawn = spawnSync } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

  function call(args, body) {
    const result = spawn('gh', ['api', ...args], {
      encoding: 'utf8',
      shell: false,
      env,
      input: body === undefined ? undefined : JSON.stringify(body),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }

    const data = parseJson(result.stdout);
    if (result.status !== 0) {
      const status = Number(/\(HTTP (\d{3})\)/.exec(result.stderr ?? '')?.[1]) || null;
      throw new GhError(describeFailure(result.stderr ?? '', data), { status, data });
    }
    return data;
  }

  async function request(method, path, { body, headers = {} } = {}) {
    const args = [path, '--method', method];
    for (const [name, value] of Object.entries(headers)) {
      args.push('-H', `${name}: ${value}`);
    }
    if (body !== undefined) {
      args.push('--input', '-');
    }
    return call(args, body);
  }

  async function graphql(query, variables = {}) {
    const data = call(['graphql', '--input', '-'], { query, variables });
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      throw new GhError(data.errors.map((error) => error.message).join(' | '), { data });
    }
    return data?.data;
  }

  return { request, graphql };
}

export async function paginate(client, path, { perPage = 100, maxPages = 50 } = {}) {
  const items = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await client.request('GET', `${path}${separator}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new GhError(`Expected a list from ${path}.`);
    }
    items.push(...batch);
    if (batch.length < perPage) {
      return items;
    }
  }
  return items;
}

export function statusOf(error) {
  return error instanceof GhError ? error.status : null;
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
