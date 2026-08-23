/**
 * Actors are people at the desk. The API runs with the dev-auth bypass, and a request
 * picks its user with the `cc_dev_user` cookie (see `devAuth` in apps/api/src/auth.ts), so
 * one browser can be a supervisor in one context and two agents in two others — each with
 * its own desk websocket, presence and ring dialog. Users are created and bootstrapped by
 * the API on their first request, which is how invites get accepted in the Team spec.
 */
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

/** One signed-in person: their browser context, a page on the desk, and their API client. */
export type Actor = {
  email: string;
  /** The local part of the email, which is the name the API gives a dev user. */
  name: string;
  context: BrowserContext;
  page: Page;
  /** Sends the actor's cookie, so `/api/desk/*` and `/api/admin/*` run as them. */
  request: APIRequestContext;
  close(): Promise<void>;
};

/**
 * Opens a new browser context signed in as `email`. The cookie is scoped to `localhost`
 * without a port, so it reaches the desk (3100, proxied to the API) and the API (4100).
 */
export async function newActor(browser: Browser, email: string): Promise<Actor> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'cc_dev_user', value: encodeURIComponent(email), domain: 'localhost', path: '/' },
  ]);
  const page = await context.newPage();
  return {
    email,
    name: email.split('@')[0] ?? email,
    context,
    page,
    request: context.request,
    close: () => context.close(),
  };
}
