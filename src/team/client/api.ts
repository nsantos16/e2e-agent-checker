import { z } from 'zod';
export class TeamApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export type TeamApi = <T>(
  path: string,
  schema: z.ZodType<T>,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<T>;
export function createApi(
  getToken: () => Promise<string | null>,
  onAccessLost?: () => void,
): TeamApi {
  return async (path, schema, options = {}) => {
    const token = await getToken();
    options.signal?.throwIfAborted();
    if (!token) {
      onAccessLost?.();
      throw new TeamApiError(401, 'Sign in to continue.');
    }
    const response = await fetch(`/api/team${path}`, {
      method: options.method ?? 'GET',
      signal: options.signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status) && !options.signal?.aborted)
        onAccessLost?.();
      const data = await response.json().catch(() => ({}));
      throw new TeamApiError(response.status, data.error ?? 'Request failed.');
    }
    const data = await response.json();
    return schema.parse(data);
  };
}
