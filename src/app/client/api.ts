export type Api = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export const api: Api = async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(path, {
    signal,
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data as T;
};
export const fileUrl = (path: string) => `/files?path=${encodeURIComponent(path)}`;
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const preferences = {
  get(key: string) {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (typeof window === 'undefined') return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      /* Storage may be disabled. */
    }
  },
  json<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(this.get(key) ?? 'null') ?? fallback;
    } catch {
      return fallback;
    }
  },
};
