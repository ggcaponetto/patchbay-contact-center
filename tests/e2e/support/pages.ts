/**
 * Page objects: one small class per desk page plus the embedded button. They only know
 * locators and the handful of actions a spec needs; assertions stay in the specs. Texts
 * come from the React pages (apps/web/src/pages) and the web component (apps/embed).
 */
import { type Locator, type Page, expect } from '@playwright/test';
import { API_ORIGIN, EMBED_ORIGIN } from '../../../playwright.config.ts';

/** `#/desk`: availability toggle, ring dialog, the active call panel. */
export class DeskPage {
  readonly page: Page;
  readonly dialog: Locator;
  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole('dialog');
  }
  async goto() {
    await this.page.goto('/#/desk');
    await expect(this.page.getByText(/^Hi .*, you are/)).toBeVisible();
  }
  /** The state chip in the state bar ("Ready · 0:05", "Not ready · Lunch · 0:02", …). */
  stateChip() {
    return this.page.getByText(/^(Ready|Not ready|On a call|Wrap-up)( · .*)? · \d+:\d\d$/);
  }
  async setReady() {
    await this.page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(this.page.getByText('Waiting for calls')).toBeVisible();
  }
  /** Not ready with one of the tenant's reason codes (default `Break`). */
  async setNotReady(reason = 'Break') {
    await this.page.getByRole('button', { name: 'Not ready' }).click();
    await this.page.getByRole('menuitem', { name: reason }).click();
    await expect(this.stateChip()).toContainText(`Not ready · ${reason}`);
  }
  /** Waits for the incoming-call dialog of the given queue. */
  async expectRinging(queueKey = 'support') {
    await expect(this.dialog).toContainText(`Incoming call · ${queueKey}`);
  }
  /** The routing chips inside the ring dialog (skills, language, "Requirements relaxed"). */
  offerChips() {
    return this.dialog.getByLabel('Routing requirements').locator('.MuiChip-root');
  }
  async accept() {
    await this.dialog.getByRole('button', { name: 'Accept' }).click();
    await expect(this.page.getByText('Customer call')).toBeVisible();
  }
  async decline() {
    await this.dialog.getByRole('button', { name: 'Decline' }).click();
  }
  async hangUp() {
    await this.page.getByRole('button', { name: 'Hang up' }).click();
  }
}

/** `#/dashboard`: live calls and agents online (supervisors only). */
export class DashboardPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto() {
    await this.page.goto('/#/dashboard');
    await expect(this.page.getByText(/Live calls \(\d+\)/)).toBeVisible();
  }
  liveCalls() {
    return this.page.getByText(/Live calls \(\d+\)/);
  }
  agentsOnline() {
    return this.page.getByText(/Agents online \(\d+\)/);
  }
  /** The list item of one agent, by display name. */
  agent(name: string) {
    return this.page.getByRole('listitem').filter({ hasText: name });
  }
  call(queueKey: string) {
    return this.page.getByRole('button').filter({ hasText: `${queueKey} ·` });
  }
}

/** `#/history`: the calls table. */
export class HistoryPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto() {
    await this.page.goto('/#/history');
    await expect(this.page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
  }
  rows() {
    return this.page.getByRole('row').filter({ has: this.page.getByRole('cell') });
  }
}

/** `#/calls/<id>`: detail, transcript, events, listen-in / take-over. */
export class CallPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto(id: string) {
    await this.page.goto(`/#/calls/${id}`);
    await expect(this.page.getByText(`Call ${id.slice(0, 8)}`)).toBeVisible();
  }
  statusChip() {
    return this.page.getByText(/^(Ringing|With AI|Waiting for agent|With agent|Ended)$/);
  }
  async listenIn() {
    await this.page.getByRole('button', { name: 'Listen in' }).click();
    await expect(this.page.getByText('Listening in')).toBeVisible();
  }
  async takeOver() {
    await this.page.getByRole('button', { name: 'Take over' }).click();
    await expect(this.page.getByText('You took over this call')).toBeVisible();
  }
  async stopListening() {
    await this.page.getByRole('button', { name: 'Stop listening' }).click();
  }
  async hangUp() {
    await this.page.getByRole('button', { name: 'Hang up' }).click();
  }
  transcript() {
    return this.page.getByText('Transcript').locator('..');
  }
  events() {
    return this.page.getByText('Events').locator('..');
  }
}

/** Route segment of each settings tab (`#/settings/<tab>`). */
export type SettingsTab = 'routing' | 'hours' | 'team' | 'queues' | 'sounds' | 'embed' | 'api-keys';

/** The tab labels as rendered. */
const TAB_LABELS: Record<SettingsTab, string> = {
  routing: 'Routing & AI',
  hours: 'Business hours',
  team: 'Team & skills',
  queues: 'Queues',
  sounds: 'Sounds',
  embed: 'Call button',
  'api-keys': 'API keys',
};

/**
 * `#/settings` (supervisors only): one tab per area. `goto(tab)` opens a tab directly;
 * the action helpers switch to the tab they need by themselves.
 */
export class SettingsPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto(tab: SettingsTab = 'routing') {
    await this.page.goto(`/#/settings/${tab}`);
    await expect(this.page.getByRole('tab', { name: TAB_LABELS[tab] })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
  /** Switches to a tab (no-op when already there). */
  async tab(tab: SettingsTab) {
    const t = this.page.getByRole('tab', { name: TAB_LABELS[tab] });
    if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
    await expect(t).toHaveAttribute('aria-selected', 'true');
  }
  /** The last toast shown ("Saved", an error…). */
  get toast() {
    return this.page.getByRole('status');
  }
  async createKey(label: string, allowedOrigins = '') {
    await this.tab('embed');
    await this.page.getByLabel('Label', { exact: true }).fill(label);
    if (allowedOrigins)
      await this.page.getByLabel('Allowed origins (optional)').fill(allowedOrigins);
    await this.page.getByRole('button', { name: 'Create key' }).click();
    await expect(this.page.getByText(label, { exact: true })).toBeVisible();
  }
  /** The card of one embed key (label, origins, snippet, delete button). */
  keyCard(label: string) {
    return this.page.locator('.MuiPaper-root').filter({ hasText: label }).last();
  }
  /** The `pk_…` key of the snippet shown for a given label. */
  async keyOf(label: string) {
    const snippet = await this.keyCard(label).getByLabel('Embed snippet').inputValue();
    const key = /key="(pk_[a-f0-9]+)"/.exec(snippet)?.[1];
    if (!key) throw new Error(`no key in snippet for ${label}`);
    return key;
  }
  /** Confirms the "Are you sure?" dialog of a destructive action. */
  async confirm() {
    await this.page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  }
  async deleteKey(label: string) {
    await this.tab('embed');
    await this.page.getByRole('button', { name: `delete ${label}` }).click();
    await this.confirm();
    await expect(this.page.getByText(label, { exact: true })).toHaveCount(0);
  }
  async invite(email: string, role: 'agent' | 'supervisor' = 'agent') {
    await this.tab('team');
    await this.page.getByLabel('Invite by Google email').fill(email);
    if (role !== 'agent') {
      await this.page.getByRole('combobox').filter({ hasText: 'agent' }).click();
      await this.page.getByRole('option', { name: role }).click();
    }
    await this.page.getByRole('button', { name: 'Invite' }).click();
    await expect(this.page.getByText(email).first()).toBeVisible();
  }
  async addQueue(name: string) {
    await this.tab('queues');
    await this.page.getByLabel('New queue').fill(name);
    await this.page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await expect(this.page.getByText(name, { exact: true })).toBeVisible();
  }
  /** The card of one queue. */
  queueCard(name: string) {
    return this.page
      .locator('.MuiPaper-root')
      .filter({ has: this.page.getByText(name, { exact: true }) })
      .last();
  }
  /** The membership checkbox of `memberName` inside the queue card named `queueName`. */
  queueMember(queueName: string, memberName: string) {
    return this.queueCard(queueName).getByLabel(memberName, { exact: true });
  }
  async deleteQueue(name: string) {
    await this.tab('queues');
    await this.page.getByRole('button', { name: `delete queue ${name}` }).click();
    await this.confirm();
  }
  /**
   * Adds a skill chip in the editor labelled `label` ("Add a skill to Ann", "Required
   * skills for Sales") at `level`, without saving.
   */
  async addSkill(label: string, skill: string, level: number) {
    const input = this.page.getByLabel(label);
    const stack = 'xpath=ancestor::div[contains(@class, "MuiStack-root")]';
    const row = input.locator(`${stack}[1]`);
    const editor = input.locator(`${stack}[2]`);
    await input.fill(skill);
    await row.getByRole('combobox').last().click();
    await this.page.getByRole('option', { name: String(level), exact: true }).click();
    await row.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(editor.getByText(new RegExp(`^${skill} · (level|min) ${level}$`))).toBeVisible();
  }
  /**
   * Adds a routing skill to the catalogue on the Routing & AI tab (without saving). The key
   * is derived from the label.
   */
  async addRoutingSkill(label: string, description: string) {
    await this.tab('routing');
    await this.page.getByRole('button', { name: '+ Add skill' }).click();
    await this.page.getByLabel('Label', { exact: true }).last().fill(label);
    await this.page.getByLabel('Description (what the AI should match)').last().fill(description);
  }
  async selectOption(label: string, option: string) {
    await this.page.getByLabel(label).click();
    await this.page.getByRole('option', { name: option }).click();
  }
  async save() {
    await this.page.getByRole('button', { name: 'Save', exact: true }).click();
  }
}

/** The `<cc-call-button>` on the embed demo page ("any website"). */
export class EmbedButton {
  readonly page: Page;
  readonly element: Locator;
  constructor(page: Page) {
    this.page = page;
    this.element = page.locator('cc-call-button');
  }
  /**
   * Opens the demo page; `key` empty leaves the attribute blank. `language` (BCP 47)
   * and `label` are copied onto the element too; with a `language` the page drops its
   * `label` attribute so the translated default shows. Waits for the idle button,
   * whatever its text.
   */
  async goto(
    key: string,
    opts: { queue?: string; api?: string; language?: string; label?: string } = {},
  ) {
    const params = new URLSearchParams({ api: opts.api ?? API_ORIGIN });
    if (key) params.set('key', key);
    if (opts.queue) params.set('queue', opts.queue);
    if (opts.language) params.set('language', opts.language);
    if (opts.label) params.set('label', opts.label);
    await this.page.goto(`${EMBED_ORIGIN}/?${params}`);
    await expect(this.element.getByRole('button')).toBeVisible();
  }
  async call() {
    await this.element.getByRole('button', { name: 'Call us' }).click();
  }
  async hangUp() {
    await this.element.getByRole('button', { name: 'Hang up' }).click();
  }
}
