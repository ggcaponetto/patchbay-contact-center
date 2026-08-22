/**
 * `#/settings` (supervisors only): four independent cards, each with its own queries
 * and mutations against `/api/admin/*`. Mutations invalidate the query they affect.
 */
import { type TenantSettings } from '@cc/shared';
import {
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  Grid,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiKeysCard } from '../components/ApiKeysCard.tsx';
import {
  type EmbedKey,
  type Invite,
  type Member,
  type Queue,
  type Tenant,
  api,
  del,
  patch,
  post,
  put,
} from '../lib/api.ts';

/**
 * Supervisor settings: routing & AI behavior, team, queues, embed keys.
 * Pure layout; see `RoutingCard`, `TeamCard`, `QueuesCard` and `EmbedCard`.
 */
export function Settings() {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 6 }}>
        <RoutingCard />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <TeamCard />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <QueuesCard />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <EmbedCard />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <ApiKeysCard />
      </Grid>
    </Grid>
  );
}

/**
 * Edits the tenant's `TenantSettings` (routing mode, handoff behavior, timeouts, AI
 * prompt). `GET /api/admin/tenant` seeds a local draft; Save sends
 * `PATCH /api/admin/tenant/settings` and invalidates `['tenant']`.
 */
function RoutingCard() {
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/admin/tenant') });
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  // The reason codes are edited as free text (commas would vanish while typing if the
  // field were bound to the parsed array) and parsed into the draft on every change.
  const [reasonsText, setReasonsText] = useState('');
  const [dispositionsText, setDispositionsText] = useState('');
  useEffect(() => {
    if (tenant.data) {
      setDraft(tenant.data.settings);
      setReasonsText(tenant.data.settings.notReadyReasons.join(', '));
      setDispositionsText(
        tenant.data.settings.dispositions.map((d) => `${d.code} | ${d.label}`).join('\n'),
      );
    }
  }, [tenant.data]);
  const save = useMutation({
    mutationFn: (s: TenantSettings) => patch('/admin/tenant/settings', s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant'] }),
  });
  if (!draft) return null;
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Routing & AI
      </Typography>
      <Stack spacing={2}>
        <TextField
          select
          label="Who answers first"
          value={draft.routingMode}
          onChange={(e) =>
            setDraft({ ...draft, routingMode: e.target.value as TenantSettings['routingMode'] })
          }
        >
          <MenuItem value="ai-first">AI answers, escalates to humans</MenuItem>
          <MenuItem value="human-first">Ring humans first, AI as fallback</MenuItem>
        </TextField>
        <TextField
          select
          label="When a human takes over, the AI"
          value={draft.handoff.aiBehavior}
          onChange={(e) =>
            setDraft({
              ...draft,
              handoff: { aiBehavior: e.target.value as TenantSettings['handoff']['aiBehavior'] },
            })
          }
        >
          <MenuItem value="leave">leaves the conversation (keeps transcribing)</MenuItem>
          <MenuItem value="listen">stays muted and keeps listening</MenuItem>
        </TextField>
        <Stack direction="row" spacing={2}>
          <TextField
            type="number"
            label="Ring each agent for (s)"
            value={draft.offerTimeoutSec}
            onChange={(e) => setDraft({ ...draft, offerTimeoutSec: Number(e.target.value) })}
          />
          <TextField
            type="number"
            label="Human-first timeout (s)"
            value={draft.humanFirstTimeoutSec}
            onChange={(e) => setDraft({ ...draft, humanFirstTimeoutSec: Number(e.target.value) })}
          />
          <TextField
            type="number"
            label="Wrap-up time (s, 0 = off)"
            value={draft.acwSec}
            onChange={(e) => setDraft({ ...draft, acwSec: Number(e.target.value) })}
          />
        </Stack>
        <TextField
          label="Wrap-up codes (one per line: code | label; a / in the code groups)"
          multiline
          minRows={2}
          value={dispositionsText}
          onChange={(e) => {
            setDispositionsText(e.target.value);
            setDraft({
              ...draft,
              dispositions: e.target.value
                .split('\n')
                .map((line) => {
                  const [code, label] = line.split('|').map((p) => p.trim());
                  return code ? { code, label: label || code } : null;
                })
                .filter((d): d is { code: string; label: string } => d !== null),
            });
          }}
        />
        <FormControlLabel
          label="Disposition required before finishing wrap-up"
          control={
            <Checkbox
              checked={draft.dispositionRequired}
              onChange={(e) => setDraft({ ...draft, dispositionRequired: e.target.checked })}
            />
          }
        />
        <TextField
          label="Not-ready reason codes (comma separated)"
          value={reasonsText}
          onChange={(e) => {
            setReasonsText(e.target.value);
            setDraft({
              ...draft,
              notReadyReasons: e.target.value
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean),
            });
          }}
        />
        <TextField
          label="AI greeting instruction"
          value={draft.aiAgent.greeting}
          onChange={(e) =>
            setDraft({ ...draft, aiAgent: { ...draft.aiAgent, greeting: e.target.value } })
          }
        />
        <TextField
          label="Company instructions for the AI"
          multiline
          minRows={4}
          placeholder="Opening hours, products, what the AI may and may not do…"
          value={draft.aiAgent.instructions}
          onChange={(e) =>
            setDraft({ ...draft, aiAgent: { ...draft.aiAgent, instructions: e.target.value } })
          }
        />
        <Button variant="contained" onClick={() => save.mutate(draft)} disabled={save.isPending}>
          Save
        </Button>
        {save.isError && <Typography color="error">{String(save.error)}</Typography>}
      </Stack>
    </Paper>
  );
}

/**
 * Members and pending invites. `GET /api/admin/members`, `GET /api/admin/invites`,
 * `POST /api/admin/invites { email, role }`. Invites are matched by Google email at sign-in.
 */
function TeamCard() {
  const qc = useQueryClient();
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Member[]>('/admin/members'),
  });
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api<Invite[]>('/admin/invites'),
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'agent' | 'supervisor'>('agent');
  const invite = useMutation({
    mutationFn: () => post('/admin/invites', { email, role }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['invites'] });
    },
  });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Team
      </Typography>
      <Stack spacing={1} sx={{ mb: 2 }}>
        {(members.data ?? []).map((m) => (
          <Stack key={m.userId} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography>{m.name}</Typography>
            <Typography color="text.secondary">{m.email}</Typography>
            <Chip size="small" label={m.role} />
          </Stack>
        ))}
        {(invites.data ?? [])
          .filter((i) => !i.acceptedAt)
          .map((i) => (
            <Stack key={i.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography color="text.secondary">{i.email}</Typography>
              <Chip size="small" variant="outlined" label={`invited as ${i.role}`} />
            </Stack>
          ))}
      </Stack>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label="Invite by Google email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          sx={{ flex: 1 }}
        />
        <TextField
          select
          size="small"
          value={role}
          onChange={(e) => setRole(e.target.value as 'agent' | 'supervisor')}
        >
          <MenuItem value="agent">agent</MenuItem>
          <MenuItem value="supervisor">supervisor</MenuItem>
        </TextField>
        <Button variant="contained" onClick={() => invite.mutate()} disabled={!email}>
          Invite
        </Button>
      </Stack>
    </Paper>
  );
}

/**
 * Queues and which agents are rung for each. `GET /api/admin/queues`,
 * `POST /api/admin/queues { key, name }` (key = name for now) and
 * `PUT /api/admin/queues/:id/members { userIds }` on every checkbox change.
 */
function QueuesCard() {
  const qc = useQueryClient();
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<Queue[]>('/admin/queues') });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Member[]>('/admin/members'),
  });
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['queues'] });
  const create = useMutation({
    mutationFn: () => post('/admin/queues', { key: name, name }),
    onSuccess: () => {
      setName('');
      void refresh();
    },
  });
  const setMembers = useMutation({
    mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) =>
      put(`/admin/queues/${id}/members`, { userIds }),
    onSuccess: refresh,
  });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Queues
      </Typography>
      {(queues.data ?? []).map((q) => (
        <Stack key={q.id} sx={{ mb: 1 }}>
          <Typography>
            <b>{q.name}</b>{' '}
            <Typography component="span" color="text.secondary">
              ({q.key})
            </Typography>
          </Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
            {(members.data ?? []).map((m) => (
              <FormControlLabel
                key={m.userId}
                label={m.name}
                control={
                  <Checkbox
                    size="small"
                    checked={q.memberIds.includes(m.userId)}
                    onChange={(e) =>
                      setMembers.mutate({
                        id: q.id,
                        userIds: e.target.checked
                          ? [...q.memberIds, m.userId]
                          : q.memberIds.filter((u) => u !== m.userId),
                      })
                    }
                  />
                }
              />
            ))}
          </Stack>
        </Stack>
      ))}
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label="New queue"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button variant="contained" onClick={() => create.mutate()} disabled={!name}>
          Add
        </Button>
      </Stack>
    </Paper>
  );
}

/**
 * Embed keys for the website call button. `GET/POST/DELETE /api/admin/embed-keys`.
 * For each key a ready-to-paste snippet is shown; it uses the desk's own origin as the
 * API origin, which is right in dev (Vite proxies `/api` and `/embed`) and whenever the
 * desk is served by the API.
 */
function EmbedCard() {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ['embedKeys'],
    queryFn: () => api<EmbedKey[]>('/admin/embed-keys'),
  });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<Queue[]>('/admin/queues') });
  const [label, setLabel] = useState('');
  const [origins, setOrigins] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['embedKeys'] });
  const create = useMutation({
    mutationFn: () =>
      post('/admin/embed-keys', {
        label,
        allowedOrigins: origins.split(/[\s,]+/).filter(Boolean),
      }),
    onSuccess: () => {
      setLabel('');
      setOrigins('');
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/embed-keys/${id}`),
    onSuccess: refresh,
  });
  const apiOrigin = location.origin;
  const queueKey = queues.data?.[0]?.key ?? 'support';
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Call button for your website
      </Typography>
      {(keys.data ?? []).map((k) => (
        <Paper key={k.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
          <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
            <Typography sx={{ flex: 1 }}>
              <b>{k.label}</b>{' '}
              <Typography component="span" color="text.secondary">
                {k.allowedOrigins.length ? k.allowedOrigins.join(', ') : 'any origin'}
              </Typography>
            </Typography>
            <IconButton
              size="small"
              onClick={() => remove.mutate(k.id)}
              aria-label={`delete ${k.label}`}
            >
              ✕
            </IconButton>
          </Stack>
          <TextField
            fullWidth
            size="small"
            multiline
            label="Embed snippet"
            slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12 } } }}
            value={`<script src="${apiOrigin}/embed/call-button.js"></script>\n<cc-call-button key="${k.publicKey}" queue="${queueKey}" api="${apiOrigin}" label="Call us"></cc-call-button>`}
            sx={{ mt: 1 }}
          />
        </Paper>
      ))}
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          size="small"
          label="Allowed origins (optional)"
          placeholder="https://www.example.com"
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button variant="contained" onClick={() => create.mutate()} disabled={!label}>
          Create key
        </Button>
      </Stack>
    </Paper>
  );
}
