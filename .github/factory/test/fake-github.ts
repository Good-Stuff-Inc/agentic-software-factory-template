import { GhError, type GhClient } from '../lib/gh.mjs';

export interface Call {
  kind: 'rest' | 'graphql';
  method?: string;
  path?: string;
  body?: any;
  headers?: Record<string, string>;
  query?: string;
  variables?: any;
}

type RestHandler = (call: Call) => unknown;
type GraphqlHandler = (variables: any, query: string) => unknown;

export function httpError(status: number, message = `HTTP ${status}`) {
  return new GhError(`${message} (HTTP ${status})`, { status });
}

// Routes REST calls by "METHOD /path" (query string ignored) and GraphQL calls
// by the first operation field name, so tests describe GitHub, not call order.
export function fakeClient({
  rest = {},
  graphql = {},
}: {
  rest?: Record<string, RestHandler | unknown>;
  graphql?: Record<string, GraphqlHandler | unknown>;
} = {}) {
  const calls: Call[] = [];

  const client: GhClient = {
    async request(method, path, { body, headers } = {}) {
      const call: Call = { kind: 'rest', method, path, body, headers };
      calls.push(call);
      const key = `${method} ${path.split('?')[0]}`;
      if (!(key in rest)) {
        throw httpError(404, `No fake route for ${key}`);
      }
      const handler = rest[key];
      return typeof handler === 'function' ? (handler as RestHandler)(call) : handler;
    },
    async graphql(query, variables = {}) {
      calls.push({ kind: 'graphql', query, variables });
      const name = /\{\s*(\w+)/.exec(query)?.[1] ?? '';
      if (!(name in graphql)) {
        throw new GhError(`No fake GraphQL route for ${name}`);
      }
      const handler = graphql[name];
      return typeof handler === 'function' ? (handler as GraphqlHandler)(variables, query) : handler;
    },
  };

  return {
    client,
    calls,
    writes: () => calls.filter((call) => (call.kind === 'rest' && call.method !== 'GET')
      || (call.kind === 'graphql' && /^\s*mutation/.test(call.query ?? ''))),
  };
}

export const orgRepo = {
  owner: { login: 'octo-org', type: 'Organization' },
  name: 'example',
  full_name: 'octo-org/example',
  node_id: 'REPO_ID',
  default_branch: 'main',
};
