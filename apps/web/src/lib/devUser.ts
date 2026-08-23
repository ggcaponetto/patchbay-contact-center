/**
 * Development only: which dev user this browser tab is.
 *
 * With the API's `DEV_USER_EMAIL` bypass, a request can name its user with the
 * `x-dev-user` header (see `devAuth` in apps/api/src/auth.ts). This module keeps that
 * choice in `sessionStorage` — which is per tab — so several people can be signed in
 * side by side in one browser:
 *
 * - {@link bootDevUser} (called once in `main.tsx`) picks `as=<email>` up from the URL
 *   (`?as=` or `#/?as=`), stores it and strips it from the address bar.
 * - {@link devHeaders} is spread into every API request and {@link devUser} into the
 *   websocket URL.
 * - {@link setDevUser} is what the "Signed in as …" menu calls; {@link openAs} opens a new
 *   tab that boots as someone else.
 *
 * A tab without a stored choice is the API's default dev user. Every function tolerates
 * a missing or throwing `sessionStorage` (privacy modes, sandboxed iframes).
 */

/** `sessionStorage` key holding the email; same name as the API's cookie, by design. */
const KEY = 'cc_dev_user';
/** Query parameter naming the dev user, on the URL and the websocket. */
const PARAM = 'as';
/** Header the API reads (`DEV_USER_HEADER` in apps/api/src/auth.ts). */
const HEADER = 'x-dev-user';

/** `sessionStorage` if it is usable, else `null`. */
function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The dev user this tab runs as, or `null` for the API's default. */
export function devUser(): string | null {
  try {
    return storage()?.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Makes this tab run as `email` from the next request on (`null`: back to the default). */
export function setDevUser(email: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (email) s.setItem(KEY, email.trim().toLowerCase());
    else s.removeItem(KEY);
  } catch {
    // storage unavailable: the tab stays the default user
  }
}

/** The `x-dev-user` header for this tab, or `{}` when it is the default user. */
export function devHeaders(): Record<string, string> {
  const email = devUser();
  return email ? { [HEADER]: email } : {};
}

/** Reads `as` from the search part of `location` and from the query part of the hash. */
function userFromUrl(): string | null {
  const { search, hash } = location;
  const fromSearch = new URLSearchParams(search).get(PARAM);
  const q = hash.indexOf('?');
  const fromHash = q === -1 ? null : new URLSearchParams(hash.slice(q + 1)).get(PARAM);
  return fromSearch || fromHash || null;
}

/** Strips `as` from `location` without a navigation (search and hash alike). */
function stripFromUrl(): void {
  const url = new URL(location.href);
  url.searchParams.delete(PARAM);
  const q = url.hash.indexOf('?');
  if (q !== -1) {
    const params = new URLSearchParams(url.hash.slice(q + 1));
    params.delete(PARAM);
    const rest = params.toString();
    url.hash = url.hash.slice(0, q) + (rest ? `?${rest}` : '');
  }
  history.replaceState(history.state, '', url.toString());
}

/**
 * Adopts the dev user named in the URL (`?as=` or `#/?as=`), if any, and cleans the URL.
 * Call it before rendering, so the first request already carries the header.
 *
 * @returns The dev user this tab now runs as (`null` for the default).
 */
export function bootDevUser(): string | null {
  const wanted = userFromUrl();
  if (wanted) {
    setDevUser(wanted);
    stripFromUrl();
  }
  return devUser();
}

/** Opens the desk in a new tab signed in as `email` (via `#/?as=`). */
export function openAs(email: string): void {
  window.open(`${location.pathname}#/?as=${encodeURIComponent(email)}`, '_blank');
}
