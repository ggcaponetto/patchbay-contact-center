// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import type { Me } from './lib/api.ts';
import { type Route, initialState } from './lib/store.ts';

const mocks = vi.hoisted(() => ({
  session: { isPending: true, data: null as null | { user: { id: string } } },
  signIn: vi.fn(),
  signOut: vi.fn(),
  api: vi.fn(),
  setTenant: vi.fn(),
  route: { page: 'desk' } as Route,
  connected: false,
  useDeskSocket: vi.fn(),
}));
vi.mock('./lib/api.ts', () => ({
  api: mocks.api,
  setTenant: mocks.setTenant,
  authClient: {
    useSession: () => mocks.session,
    signIn: { social: mocks.signIn },
    signOut: mocks.signOut,
  },
}));
vi.mock('./lib/hooks.ts', () => ({
  useRoute: () => mocks.route,
  useDeskSocket: (tenantId: string | undefined) => {
    mocks.useDeskSocket(tenantId);
    return {
      state: { ...initialState, connected: mocks.connected },
      dispatch: vi.fn(),
      send: vi.fn(),
      setStatus: vi.fn(),
    };
  },
}));
vi.mock('./pages/Desk.tsx', () => ({ Desk: () => <div>DeskPage</div> }));
vi.mock('./pages/Dashboard.tsx', () => ({ Dashboard: () => <div>DashboardPage</div> }));
vi.mock('./pages/History.tsx', () => ({ History: () => <div>HistoryPage</div> }));
vi.mock('./pages/Settings.tsx', () => ({ Settings: () => <div>SettingsPage</div> }));
vi.mock('./pages/CallPage.tsx', () => ({
  CallPage: ({ id, supervisor }: { id: string; supervisor: boolean }) => (
    <div>
      CallPage {id} {String(supervisor)}
    </div>
  ),
}));

const me = (memberships: Me['memberships']): Me => ({
  user: { id: 'u1', email: 'ann@x', name: 'Ann' },
  isAdmin: false,
  memberships,
});

const renderApp = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <App />
    </QueryClientProvider>,
  );

describe('App', () => {
  beforeEach(() => {
    mocks.session = { isPending: false, data: { user: { id: 'u1' } } };
    mocks.route = { page: 'desk' };
    mocks.connected = true;
    mocks.api.mockReset();
    mocks.setTenant.mockReset();
    mocks.useDeskSocket.mockReset();
    location.hash = '';
  });
  afterEach(cleanup);

  it('spins while the session loads', () => {
    mocks.session = { isPending: true, data: null };
    renderApp();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('offers Google sign-in without a session', async () => {
    mocks.session = { isPending: false, data: null };
    renderApp();
    await userEvent.click(screen.getByText('Sign in with Google'));
    expect(mocks.signIn).toHaveBeenCalledWith({ provider: 'google', callbackURL: '/' });
  });

  it('spins while /me loads, then asks for an invite without memberships', async () => {
    mocks.api.mockResolvedValue(me([]));
    renderApp();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'ann@x is not a member of any contact center',
    );
    expect(mocks.useDeskSocket).toHaveBeenLastCalledWith(undefined);
    await userEvent.click(screen.getByText('Sign out'));
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('renders the agent shell with the desk and a connecting banner', async () => {
    mocks.connected = false;
    mocks.api.mockResolvedValue(me([{ tenantId: 't1', role: 'agent', tenantName: 'Acme' }]));
    renderApp();
    expect(await screen.findByText('DeskPage')).toBeTruthy();
    expect(screen.getByText('Connecting to the desk…')).toBeTruthy();
    expect(screen.getByText('Ann')).toBeTruthy();
    expect(mocks.setTenant).toHaveBeenCalledWith('t1');
    expect(mocks.useDeskSocket).toHaveBeenLastCalledWith('t1');
    expect(screen.queryByRole('tab', { name: 'Dashboard' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Contact center' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(location.hash).toBe('#/history');
    await userEvent.click(screen.getByText('Sign out'));
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('shows the switch-user menu instead of the plain name in dev mode', async () => {
    mocks.api.mockResolvedValue({
      ...me([{ tenantId: 't1', role: 'agent', tenantName: 'Acme' }]),
      devMode: true,
    });
    renderApp();
    expect(await screen.findByText('Signed in as Ann')).toBeTruthy();
  });

  it('gives supervisors extra tabs, routes every page and switches tenant', async () => {
    mocks.api.mockResolvedValue(
      me([
        { tenantId: 't1', role: 'supervisor', tenantName: 'Acme' },
        { tenantId: 't2', role: 'agent', tenantName: 'Orbit' },
      ]),
    );
    mocks.route = { page: 'dashboard' };
    const { rerender } = renderApp();
    expect(await screen.findByText('DashboardPage')).toBeTruthy();
    expect(screen.queryByText('Connecting to the desk…')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();

    const view = (route: Route) => {
      mocks.route = route;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <App />
        </QueryClientProvider>,
      );
    };
    view({ page: 'settings' });
    expect(screen.getByText('SettingsPage')).toBeTruthy();
    view({ page: 'history' });
    expect(screen.getByText('HistoryPage')).toBeTruthy();
    view({ page: 'call', id: 'c1' });
    expect(screen.getByText('CallPage c1 true')).toBeTruthy();
    // The call page lives under the History tab.
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');

    await userEvent.click(screen.getByRole('combobox', { name: 'Contact center' }));
    await userEvent.click(within(screen.getByRole('listbox')).getByText('Orbit'));
    await waitFor(() => expect(mocks.setTenant).toHaveBeenLastCalledWith('t2'));
    expect(mocks.useDeskSocket).toHaveBeenLastCalledWith('t2');
    // The second membership is a plain agent: supervisor tabs disappear.
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });
});
