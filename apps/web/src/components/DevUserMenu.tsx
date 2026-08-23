/**
 * Development only: the "Signed in as …" menu in the app bar that switches the desk to
 * another person. Shown when `GET /api/me` reports `devMode` (the API runs with the
 * `DEV_USER_EMAIL` bypass). Lists everyone in the database (`GET /api/auth/dev-users`,
 * the seeded demo team included) plus "Other email…"; choosing one stores the email in
 * this tab's `sessionStorage` (`lib/devUser.ts`, sent as the `x-dev-user` header) and
 * reloads so the desk websocket reconnects as that person — no server round-trip.
 *
 * One identity per tab: "Open in new tab" next to a person opens the desk as them in a
 * fresh tab; a new tab starts as the default dev user unless opened from this menu or
 * with `#/?as=email`. When this tab is not the default user, "Back to <default>" forgets
 * the choice.
 */
import { Button, Divider, ListItemText, Menu, MenuItem } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api.ts';
import { devUser, openAs, setDevUser } from '../lib/devUser.ts';

/** What `GET /api/auth/dev-users` returns. */
type DevUsers = { current: string; users: { id: string; email: string; name: string }[] };

/** Props of {@link DevUserMenu}. */
type Props = {
  /** The signed-in user's display name (button label). */
  name: string;
  /** Called after a successful switch; defaults to a full reload. */
  onSwitched?: () => void;
};

/** App-bar menu to become another dev user. See the module comment. */
export function DevUserMenu({ name, onSwitched = () => location.reload() }: Props) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const users = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api<DevUsers>('/auth/dev-users'),
    enabled: anchor !== null,
  });
  const chosen = devUser();
  // The API's default dev user: `dev-users.current` answered without our header.
  const defaultUser = useQuery({
    queryKey: ['dev-users', 'default'],
    queryFn: () => api<DevUsers>('/auth/dev-users', { headers: { 'x-dev-user': '' } }),
    enabled: anchor !== null && chosen !== null,
    select: (d) => d.current,
  });
  const switchTo = (email: string | null) => {
    setAnchor(null);
    setDevUser(email);
    onSwitched();
  };
  return (
    <>
      <Button size="small" variant="outlined" onClick={(e) => setAnchor(e.currentTarget)}>
        {t('devUser.signedInAs', { name })}
      </Button>
      <Menu open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {(users.data?.users ?? []).map((u) => (
          <MenuItem
            key={u.id}
            selected={u.email === users.data?.current}
            onClick={() => switchTo(u.email)}
            sx={{ gap: 2 }}
          >
            <ListItemText primary={u.name} secondary={u.email} />
            <Button
              size="small"
              aria-label={t('devUser.openInNewTabAs', { name: u.name })}
              onClick={(e) => {
                e.stopPropagation();
                setAnchor(null);
                openAs(u.email);
              }}
            >
              {t('devUser.openInNewTab')}
            </Button>
          </MenuItem>
        ))}
        <Divider />
        {chosen !== null && (
          <MenuItem onClick={() => switchTo(null)}>
            {t('devUser.backTo', { name: defaultUser.data ?? t('devUser.defaultUser') })}
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            const email = window.prompt(t('devUser.prompt'));
            if (email) switchTo(email);
            else setAnchor(null);
          }}
        >
          {t('devUser.otherEmail')}
        </MenuItem>
      </Menu>
    </>
  );
}
