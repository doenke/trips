import { app } from './state.svelte';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | FormData;

/** Fetches JSON from the server. 401 sends the user back to the login. */
export async function api<T>(path: string, opts: { method?: string; body?: Body } = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: opts.body && !isForm ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server. Bist du offline?');
  }
  if (res.status === 401) {
    app.me = null;
    throw new ApiError(401, 'Bitte neu anmelden.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? `Fehler ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: Body) => api<T>(path, { method: 'POST', body: body ?? {} });
export const patch = <T>(path: string, body: Body) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body: Body) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
