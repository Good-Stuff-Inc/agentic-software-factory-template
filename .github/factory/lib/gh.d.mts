export class GhError extends Error {
  constructor(message: string, details?: { status?: number | null; data?: unknown });
  status: number | null;
  data: unknown;
}

export interface GhClient {
  request(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<any>;
  graphql(query: string, variables?: Record<string, unknown>): Promise<any>;
}

export function createGhClient(options?: { token?: string; spawn?: (...args: any[]) => any }): GhClient;
export function paginate(client: GhClient, path: string, options?: { perPage?: number; maxPages?: number }): Promise<any[]>;
export function statusOf(error: unknown): number | null;
export function messageOf(error: unknown): string;
