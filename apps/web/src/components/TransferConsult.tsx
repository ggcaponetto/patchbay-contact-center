/**
 * Transfer and consultation controls inside the call panel:
 *
 * - **Transfer** (blind): pick a queue or an online colleague; the server parks the
 *   customer with music and rings the target — this desk closes its panel right away.
 * - **Consult**: pick an online colleague; the customer goes on hold and the colleague
 *   is rung into the same room. While two humans are on the call the completion buttons
 *   appear: hand the call over, conference everyone, or drop the consultant.
 *
 * Swap/alternate is the Hold button: retrieve to bring the customer in, hold to speak
 * privately with the consultant.
 */
import type { AgentPresence } from '@cc/shared';
import { Button, Menu, MenuItem, Stack } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type DeskSettings, api, post } from '../lib/api.ts';

/** Props of {@link TransferConsult}. */
type Props = {
  callId: string;
  /** The signed-in user's id (excluded from target lists). */
  myUserId: string;
  /** Active humans on the call besides me (consultants); enables the completion buttons. */
  consultants: { userId: string | null; name: string }[];
  /** Called after a blind transfer or a completed hand-over: this desk is off the call. */
  onLeft: () => void;
  /** Reports a failed request to the page. */
  onError: (message: string) => void;
};

/** See the module comment. */
export function TransferConsult({ callId, myUserId, consultants, onLeft, onError }: Props) {
  const [menu, setMenu] = useState<{ kind: 'transfer' | 'consult'; anchor: HTMLElement } | null>(
    null,
  );
  const agents = useQuery({
    queryKey: ['desk-agents'],
    queryFn: () => api<AgentPresence[]>('/desk/agents'),
    enabled: menu !== null,
    refetchInterval: 5000,
  });
  const settings = useQuery({
    queryKey: ['desk-settings'],
    queryFn: () => api<DeskSettings>('/desk/settings'),
  });
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn();
      after?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  const pick = (fn: () => Promise<unknown>, after?: () => void) => {
    setMenu(null);
    void run(fn, after);
  };
  const colleagues = (agents.data ?? []).filter(
    (a) => a.userId !== myUserId && a.state === 'ready',
  );
  const inConsult = consultants.length > 0;

  return (
    <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
      {!inConsult && (
        <>
          <Button
            size="small"
            variant="outlined"
            onClick={(e) => setMenu({ kind: 'transfer', anchor: e.currentTarget })}
          >
            Transfer
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={(e) => setMenu({ kind: 'consult', anchor: e.currentTarget })}
          >
            Consult
          </Button>
        </>
      )}
      {inConsult && (
        <>
          <Button
            size="small"
            variant="contained"
            onClick={() =>
              void run(
                () => post(`/desk/calls/${callId}/consult/complete`, { mode: 'transfer' }),
                onLeft,
              )
            }
          >
            Hand over to {consultants[0]!.name}
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              void run(() => post(`/desk/calls/${callId}/consult/complete`, { mode: 'conference' }))
            }
          >
            Conference
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="warning"
            onClick={() =>
              void run(() => post(`/desk/calls/${callId}/consult/complete`, { mode: 'drop' }))
            }
          >
            Drop {consultants[0]!.name}
          </Button>
        </>
      )}
      <Menu open={menu !== null} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
        {menu?.kind === 'transfer' &&
          (settings.data?.queues ?? []).map((q) => (
            <MenuItem
              key={q.id}
              onClick={() =>
                pick(
                  () =>
                    post(`/desk/calls/${callId}/transfer`, {
                      target: { kind: 'queue', id: q.id },
                    }),
                  onLeft,
                )
              }
            >
              Queue: {q.name}
            </MenuItem>
          ))}
        {colleagues.map((a) => (
          <MenuItem
            key={a.userId}
            onClick={() =>
              menu?.kind === 'transfer'
                ? pick(
                    () =>
                      post(`/desk/calls/${callId}/transfer`, {
                        target: { kind: 'user', id: a.userId },
                      }),
                    onLeft,
                  )
                : pick(() => post(`/desk/calls/${callId}/consult`, { targetUserId: a.userId }))
            }
          >
            {a.name}
          </MenuItem>
        ))}
        {colleagues.length === 0 && (menu?.kind === 'consult' || !settings.data?.queues.length) && (
          <MenuItem disabled>Nobody is ready</MenuItem>
        )}
      </Menu>
    </Stack>
  );
}
