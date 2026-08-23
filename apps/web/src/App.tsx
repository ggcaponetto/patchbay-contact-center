/**
 * Root of the agent desk.
 *
 * {@link App} is a session gate: spinner while Better Auth resolves the session, the
 * Google sign-in screen without a session, otherwise the `Shell`. The `Shell` loads
 * `GET /api/me`, picks a tenant (first membership, or the one chosen in the selector),
 * opens the desk websocket through `useDeskSocket` and renders the page selected by the
 * hash route. Supervisors get extra tabs (Dashboard, Wallboard, Settings). The app bar
 * also hosts the language menu and, with several memberships, the tenant selector; on
 * narrow screens (below `md`) those controls fold into an account menu.
 */
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  IconButton,
  Menu,
  MenuItem,
  Select,
  SvgIcon,
  Tab,
  Tabs,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
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

/** Material "account circle" glyph (inline: the icon package is not a dependency). */
function AccountIcon() {
  return (
    <SvgIcon>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2a7.2 7.2 0 0 1-6-3.22c.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08a7.2 7.2 0 0 1-6 3.22z" />
    </SvgIcon>
  );
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
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('md'));
  const [account, setAccount] = useState<HTMLElement | null>(null);

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

  const tenantSelect = memberships.length > 1 && (
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
  );
  const whoAmI = me.data?.devMode ? (
    <DevUserMenu name={me.data.user.name} />
  ) : (
    <Typography variant="body2" color="text.secondary">
      {me.data?.user.name}
    </Typography>
  );

  return (
    <>
      <Button
        href="#main"
        sx={{
          position: 'absolute',
          left: 8,
          top: 8,
          zIndex: (th) => th.zIndex.appBar + 1,
          // Visually hidden until it receives keyboard focus.
          '&:not(:focus-visible)': {
            clip: 'rect(0 0 0 0)',
            // literal pixels: a bare number would mean 100% in the sx width scale
            width: '1px',
            minWidth: '1px',
            height: '1px',
            padding: 0,
            overflow: 'hidden',
          },
        }}
      >
        {t('app.skipToContent')}
      </Button>
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" component="div" sx={{ mr: 2 }}>
            {t('app.brand')}
          </Typography>
          <Tabs
            value={tab}
            onChange={(_e, v: string) => (location.hash = `#/${v}`)}
            aria-label={t('app.navigation')}
            sx={{ minWidth: 0 }}
          >
            <Tab value="desk" label={t('app.tabs.desk')} />
            {supervisor && <Tab value="dashboard" label={t('app.tabs.dashboard')} />}
            {supervisor && <Tab value="wallboard" label={t('app.tabs.wallboard')} />}
            <Tab value="history" label={t('app.tabs.history')} />
            {supervisor && <Tab value="settings" label={t('app.tabs.settings')} />}
          </Tabs>
          <Box sx={{ flex: 1 }} />
          {narrow ? (
            <>
              <IconButton
                aria-label={t('app.account')}
                aria-haspopup="menu"
                onClick={(e) => setAccount(e.currentTarget)}
              >
                <AccountIcon />
              </IconButton>
              <Menu
                open={account !== null}
                anchorEl={account}
                onClose={() => setAccount(null)}
                slotProps={{ list: { 'aria-label': t('app.account') } }}
              >
                <MenuItem disableRipple sx={{ '&:hover': { bgcolor: 'transparent' } }}>
                  <LanguageMenu />
                </MenuItem>
                {tenantSelect && (
                  <MenuItem disableRipple sx={{ '&:hover': { bgcolor: 'transparent' } }}>
                    {tenantSelect}
                  </MenuItem>
                )}
                <MenuItem disableRipple sx={{ '&:hover': { bgcolor: 'transparent' } }}>
                  {whoAmI}
                </MenuItem>
                <MenuItem onClick={() => authClient.signOut()}>{t('app.signOut')}</MenuItem>
              </Menu>
            </>
          ) : (
            <>
              <LanguageMenu />
              {tenantSelect}
              {whoAmI}
              <Button onClick={() => authClient.signOut()}>{t('app.signOut')}</Button>
            </>
          )}
        </Toolbar>
      </AppBar>
      <Container
        component="main"
        id="main"
        maxWidth={route.page === 'settings' ? 'xl' : 'lg'}
        sx={{ py: 3 }}
      >
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
