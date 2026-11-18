import type { AuthConfig, Me, User } from './types';

/** App-wide state. localStorage keys always start with "trips:". */
export const app = $state({
  me: null as Me | null,
  config: null as AuthConfig | null,
  users: [] as User[],
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  toast: '' as string,
  path: typeof location === 'undefined' ? '/' : location.pathname,
  /** The trip on screen, so a dropped booking lands in it (if the user may edit it). */
  dropTrip: null as { id: string; canEdit: boolean } | null,
  /** Bumped after an import, so the open trip reloads. */
  importTick: 0,
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  app.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (app.toast = ''), 2600);
}

export function navigate(path: string, replace = false): void {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  app.path = location.pathname;
  window.scrollTo(0, 0);
}

/** For <a href> inside the app: no full page load. */
export function link(event: MouseEvent): void {
  const a = (event.currentTarget as HTMLAnchorElement | null) ?? null;
  if (!a || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(a.getAttribute('href') ?? '/');
}

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`trips:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`trips:${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}
