/**
 * Development only: the "Signed in as …" menu in the app bar that switches the desk to
 * another person. Shown when `GET /api/me` reports `devMode` (the API runs with the
 * `DEV_USER_EMAIL` bypass). Lists everyone in the database (`GET /api/auth/dev-users`,
 * the seeded demo team included) plus "Other email…"; choosing one calls
 * `POST /api/auth/dev-switch`, which sets the `cc_dev_user` cookie, and reloads so the
 * desk websocket reconnects as that person. One identity per browser profile: open an
 * incognito window to be a second agent at the same time.
 */
import { Button, Divider, ListItemText, Menu, MenuItem } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, post } from '../lib/api.ts';

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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const users = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api<DevUsers>('/auth/dev-users'),
    enabled: anchor !== null,
  });
  const switchTo = async (email: string) => {
    setAnchor(null);
    await post('/auth/dev-switch', { email });
    onSwitched();
  };
  return (
    <>
      <Button size="small" variant="outlined" onClick={(e) => setAnchor(e.currentTarget)}>
        Signed in as {name}
      </Button>
      <Menu open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {(users.data?.users ?? []).map((u) => (
          <MenuItem
            key={u.id}
            selected={u.email === users.data?.current}
            onClick={() => void switchTo(u.email)}
          >
            <ListItemText primary={u.name} secondary={u.email} />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            const email = window.prompt('Sign in as (email)');
            if (email) void switchTo(email);
            else setAnchor(null);
          }}
        >
          Other email…
        </MenuItem>
      </Menu>
    </>
  );
}
