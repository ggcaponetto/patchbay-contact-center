/**
 * Root of the agent desk.
 *
 * {@link App} is a session gate: spinner while Better Auth resolves the session, the
 * Google sign-in screen without a session, otherwise the `Shell`. The `Shell` loads
 * `GET /api/me`, picks a tenant (first membership, or the one chosen in the selector),
 * opens the desk websocket through `useDeskSocket` and renders the page selected by the
 * hash route. Supervisors get extra tabs (Dashboard, Wallboard, Settings). The app bar
 * also hosts the language menu and, with several memberships, the tenant selector.
 */
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  MenuItem,
  Select,
  Tab,
  Tabs,
  Toolbar,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { DevUserMenu } from './components/DevUserMenu.tsx';
import { LanguageMenu } from './components/LanguageMenu.tsx';
import { MessageCenter } from './components/MessageCenter.tsx';
import { type Me, api, authClient, setTenant } from './lib/api.ts';
import { useDeskSocket, useRoute } from './lib/hooks.ts';
import { CallPage } from './pages/CallPage.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Desk } from './pages/Desk.tsx';
import { History } from './pages/History.tsx';
import { Settings } from './pages/Settings.tsx';
import { Wallboard } from './pages/Wallboard.tsx';

/**
 * Session gate. Renders a spinner while the session is loading, `SignIn` when there is
 * none and the tenant-aware `Shell` otherwise. Uses `authClient.useSession()` which
 * calls `GET /api/auth/get-session`.
 */
export function App() {
  const session = authClient.useSession();
  if (session.isPending)
    return (
      <Centered>
        <CircularProgress />
      </Centered>
    );
  if (!session.data) return <SignIn />;
  return <Shell />;
}

/** Full-viewport centring helper for the loading and sign-in screens. */
function Centered({ children }: { children: React.ReactNode }) {
  return <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>{children}</Box>;
}

/**
 * Sign-in screen. The only provider is Google (`authClient.signIn.social`); the API
 * redirects back to `/` once Better Auth has created the session cookie.
 */
function SignIn() {
  const { t } = useTranslation();
  return (
    <Centered>
      <Box sx={{ textAlign: 'center' }}>
        <Typography variant="h4" gutterBottom>
          {t('app.title')}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {t('app.signInHint')}
        </Typography>
        <Button
          variant="contained"
          size="large"
          onClick={() => authClient.signIn.social({ provider: 'google', callbackURL: '/' })}
        >
          {t('app.signInWithGoogle')}
        </Button>
      </Box>
    </Centered>
  );
}

/**
 * Signed-in frame: app bar with tabs, tenant selector, sign-out, and the current page.
 *
 * - Loads `GET /api/me`; with no membership the user is told to ask for an invite.
 * - The selected membership drives `setTenant` (the `x-tenant-id` header of every API
 *   call) and the websocket tenant, so switching tenant reconnects the socket.
 * - Pages receive the `desk` object from `useDeskSocket` as a prop; there is no context.
 * - The call page lives under the History tab (route `#/calls/<id>`).
 */
function Shell() {
  const { t } = useTranslation();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const qc = useQueryClient();
  const [tenantId, setTenantId] = useState('');
  const memberships = me.data?.memberships ?? [];
  const membership = memberships.find((m) => m.tenantId === tenantId) ?? memberships[0];
  // Keep the module-level tenant (api.ts) in sync with the selected membership.
  // Every other query is tenant-scoped by the header, not by its key: refetch them all.
  useEffect(() => {
    if (membership) {
      setTenant(membership.tenantId);
      setTenantId(membership.tenantId);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    }
  }, [membership, qc]);
  const route = useRoute();
  const desk = useDeskSocket(membership?.tenantId);

  if (me.isPending)
    return (
      <Centered>
        <CircularProgress />
      </Centered>
    );
  if (!membership) {
    return (
      <Centered>
        <Alert
          severity="warning"
          action={<Button onClick={() => authClient.signOut()}>{t('app.signOut')}</Button>}
        >
          <Trans
            i18nKey="app.notMember"
            values={{ email: me.data?.user.email }}
            components={{ b: <b /> }}
          />
        </Alert>
      </Centered>
    );
  }
  const supervisor = membership.role === 'supervisor';
  const tab = route.page === 'call' ? 'history' : route.page;

  return (
    <>
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ mr: 2 }}>
            {t('app.brand')}
          </Typography>
          <Tabs value={tab} onChange={(_e, v: string) => (location.hash = `#/${v}`)}>
            <Tab value="desk" label={t('app.tabs.desk')} />
            {supervisor && <Tab value="dashboard" label={t('app.tabs.dashboard')} />}
            {supervisor && <Tab value="wallboard" label={t('app.tabs.wallboard')} />}
            <Tab value="history" label={t('app.tabs.history')} />
            {supervisor && <Tab value="settings" label={t('app.tabs.settings')} />}
          </Tabs>
          <Box sx={{ flex: 1 }} />
          <LanguageMenu />
          {memberships.length > 1 && (
            <Select
              size="small"
              inputProps={{ 'aria-label': t('app.tenant') }}
              value={membership.tenantId}
              onChange={(e) => setTenantId(String(e.target.value))}
            >
              {memberships.map((m) => (
                <MenuItem key={m.tenantId} value={m.tenantId}>
                  {m.tenantName}
                </MenuItem>
              ))}
            </Select>
          )}
          {me.data?.devMode ? (
            <DevUserMenu name={me.data.user.name} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              {me.data?.user.name}
            </Typography>
          )}
          <Button size="small" onClick={() => authClient.signOut()}>
            {t('app.signOut')}
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth={route.page === 'settings' ? 'xl' : 'lg'} sx={{ py: 3 }}>
        {desk.state.loggedOutBy ? (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={<Button onClick={() => location.reload()}>{t('app.signInAgain')}</Button>}
          >
            {t('app.loggedOutBy', { name: desk.state.loggedOutBy })}
          </Alert>
        ) : (
          !desk.state.connected && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('app.connecting')}
            </Alert>
          )
        )}
        <MessageCenter state={desk.state} />
        {route.page === 'desk' && <Desk desk={desk} me={me.data!} />}
        {route.page === 'dashboard' && supervisor && <Dashboard desk={desk} />}
        {route.page === 'wallboard' && supervisor && <Wallboard />}
        {route.page === 'history' && <History desk={desk} />}
        {route.page === 'call' && <CallPage id={route.id} desk={desk} supervisor={supervisor} />}
        {route.page === 'settings' && supervisor && <Settings tab={route.tab} />}
      </Container>
    </>
  );
}
