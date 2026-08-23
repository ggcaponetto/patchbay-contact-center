/**
 * `#/calls/<id>`: one call in detail. Agents see the transcript, AI summary and event
 * log; supervisors can additionally monitor (listen / whisper / barge) or take the
 * call (take over / intercept) while it is live.
 */
import { Button, Chip, Grid, Paper, Stack, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CallPanel, type JoinInfo, Transcript } from '../components/CallPanel.tsx';
import { type CallDetail, type DeskSettings, api, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useLocaleFormat } from '../lib/i18n.ts';
import {
  dispositionLabel,
  skillLabel,
  speakerLabel,
  statusColor,
  statusKey,
} from '../lib/store.ts';

/** Supervisor ways onto a live call; see `Flow.join` on the API for the semantics. */
type JoinMode = 'listen' | 'whisper' | 'barge' | 'takeover' | 'intercept';

/** The modes in display order; button labels are `call.modes.*`, panel titles `call.titles.*`. */
const MODES: JoinMode[] = ['listen', 'whisper', 'barge', 'takeover', 'intercept'];

/** Props of {@link CallPage}: the call id from the route and the supervisor flag from the membership. */
type Props = { id: string; desk: ReturnType<typeof useDeskSocket>; supervisor: boolean };

/**
 * One call: transcript, events, and (for supervisors) listen-in / take-over while live.
 *
 * Uses:
 * - `GET /api/desk/calls/:id` (invalidated on every `callsVersion` bump, i.e. every
 *   `call.updated` frame, while the key stays stable so the data never blanks).
 * - WS `subscribe` on mount so `transcript` frames for this call are reduced into
 *   `state.transcripts[id]`.
 * - `POST /api/desk/calls/:id/join` with `mode: 'listen' | 'takeover'` (supervisors);
 *   listen does not publish the microphone, take-over does.
 * - `POST /api/desk/calls/:id/leave` with `role: 'supervisor'` (listen) or `'human'`
 *   (take-over; ends the call).
 */
export function CallPage({ id, desk, supervisor }: Props) {
  const { t } = useTranslation();
  const { time } = useLocaleFormat();
  const { state, send } = desk;
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['call', id],
    queryFn: () => api<CallDetail>(`/desk/calls/${id}`),
  });
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['call', id] });
  }, [id, state.callsVersion, qc]);
  const settings = useQuery({
    queryKey: ['desk-settings'],
    queryFn: () => api<DeskSettings>('/desk/settings'),
  });
  const [joined, setJoined] = useState<{ mode: JoinMode; join: JoinInfo } | null>(null);
  useEffect(() => send({ type: 'subscribe', callId: id }), [id, send]);

  // Prefer the status pushed over the socket; the fetched row may be a few ms behind.
  const status = state.callStatus[id] ?? detail.data?.status;
  const live = status !== undefined && status !== 'ended';
  const join = async (mode: JoinMode) => {
    const res = await post<{ token: string; url: string }>(`/desk/calls/${id}/join`, { mode });
    setJoined({ mode, join: { ...res, publish: mode !== 'listen' } });
  };
  const leave = useCallback(async () => {
    if (!joined) return;
    const role = joined.mode === 'takeover' || joined.mode === 'intercept' ? 'human' : 'supervisor';
    setJoined(null);
    await post(`/desk/calls/${id}/leave`, { role }).catch(() => undefined);
  }, [id, joined]);

  // Transcript merge. The API persists every segment it broadcasts, so the stored rows
  // overlap with the live segments received over the socket — but only partially when
  // the page was opened mid-call (stored has segments live never saw) or when live
  // segments arrived after the last fetch. Each live segment cancels one identical
  // stored row; what remains is the tail the fetch has not caught up with yet.
  const stored = (detail.data?.transcript ?? []).map((t) => ({
    speaker: t.speaker as 'ai',
    identity: t.identity,
    text: t.text,
  }));
  const liveSegments = state.transcripts[id] ?? [];
  const seen = new Map<string, number>();
  for (const t of stored)
    seen.set(
      `${t.identity}
${t.text}`,
      (seen.get(`${t.identity}
${t.text}`) ?? 0) + 1,
    );
  const tail = liveSegments.filter((s) => {
    const k = `${s.identity}
${s.text}`;
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    return n === 0;
  });
  const transcript = [...stored, ...tail];
  const labelFor = (segment: { identity: string; speaker: string }) =>
    speakerLabel(
      segment.identity,
      segment.speaker,
      { participants: detail.data?.participants, agents: state.agents },
      t,
    );
  const skillName = (key: string) => skillLabel(key, settings.data?.skills, t);
  /** Text of one event: the escalation events tell their skills, the rest show their type. */
  const eventText = (e: { type: string; payload: Record<string, unknown> }) => {
    const list = (v: unknown) =>
      (Array.isArray(v) ? (v as string[]) : []).map(skillName).join(', ');
    if (e.type === 'escalation.relaxed')
      return t('call.events.relaxed', { skills: list(e.payload['dropped']) });
    if (e.type === 'escalation.requested' && Array.isArray(e.payload['skills']))
      return t('call.events.requested', { skills: list(e.payload['skills']) });
    return e.type;
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }} spacing={2}>
        <Button onClick={() => (location.hash = '#/history')}>{t('common.back')}</Button>
        <Typography variant="h5" component="h1">
          {t('call.title', { id: id.slice(0, 8) })}
        </Typography>
        {status && <Chip size="small" color={statusColor[status]} label={t(statusKey(status))} />}
        {detail.data && <Typography color="text.secondary">{detail.data.queueKey}</Typography>}
        {detail.data?.dispositionCode && (
          <Chip
            size="small"
            variant="outlined"
            label={dispositionLabel(detail.data.dispositionCode, settings.data?.dispositions)}
          />
        )}
        {(detail.data?.tags ?? []).map((t) => (
          <Chip key={t} size="small" label={t} />
        ))}
        {(detail.data?.requiredSkills ?? []).map((key) => (
          <Chip key={key} size="small" variant="outlined" color="info" label={skillName(key)} />
        ))}
        {detail.data?.language && (
          <Chip size="small" variant="outlined" label={skillName(`lang:${detail.data.language}`)} />
        )}
        <Stack direction="row" spacing={1} sx={{ ml: 'auto', flexWrap: 'wrap', rowGap: 1 }}>
          {supervisor && live && !joined
            ? MODES.map((mode) => (
                <Button
                  key={mode}
                  variant={mode === 'takeover' ? 'contained' : 'outlined'}
                  onClick={() => void join(mode)}
                >
                  {t(`call.modes.${mode}`)}
                </Button>
              ))
            : null}
        </Stack>
      </Stack>
      {joined ? (
        <CallPanel
          join={joined.join}
          title={t(`call.titles.${joined.mode}`)}
          transcript={transcript}
          labelFor={labelFor}
          onLeave={() => void leave()}
        />
      ) : (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 8 }}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" component="h2" gutterBottom>
                {t('call.transcript')}
              </Typography>
              <Transcript segments={transcript} labelFor={labelFor} />
              {detail.data?.aiSummary && (
                <Typography sx={{ mt: 2 }}>
                  <b>{t('call.aiSummary')}</b> {detail.data.aiSummary}
                </Typography>
              )}
            </Paper>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" component="h2" gutterBottom>
                {t('call.events.title')}
              </Typography>
              {(detail.data?.events ?? []).map((e) => (
                <Typography key={e.id} variant="body2" sx={{ mb: 0.5 }}>
                  <span style={{ opacity: 0.6 }}>{time(e.at)}</span>
                  {eventText(e)}
                </Typography>
              ))}
            </Paper>
          </Grid>
        </Grid>
      )}
    </Stack>
  );
}
