// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallDetail } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { type DeskState, initialState } from '../lib/store.ts';
import { CallPage } from './CallPage.tsx';

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api.ts', () => mocks);
vi.mock('../components/CallPanel.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/CallPanel.tsx')>()),
  CallPanel: ({
    title,
    transcript,
    onLeave,
  }: {
    title: string;
    transcript: { text: string }[];
    onLeave: () => void;
  }) => (
    <div>
      <span>{title}</span>
      <span>{transcript.map((t) => t.text).join('|')}</span>
      <button onClick={onLeave}>Leave</button>
    </div>
  ),
}));

const fakeDesk = (state: Partial<DeskState>): ReturnType<typeof useDeskSocket> => ({
  state: { ...initialState, ...state },
  dispatch: vi.fn(),
  send: vi.fn(),
  setStatus: vi.fn(),
});

const detail: CallDetail = {
  id: 'call-1234-5678',
  status: 'ai',
  queueKey: 'support',
  startedAt: '2026-01-01T00:00:00Z',
  endedAt: null,
  aiSummary: 'Wants a refund',
  customerMeta: {},
  participants: [
    {
      kind: 'human',
      identity: 'human:u1',
      userId: 'u1',
      name: 'Ann',
      joinedAt: '2026-01-01T00:00:02Z',
      leftAt: null,
    },
  ],
  transcript: [
    { id: 't1', speaker: 'ai', identity: 'ai:1', text: 'Hello', createdAt: '2026-01-01T00:00:01Z' },
    {
      id: 't2',
      speaker: 'customer',
      identity: 'customer:call-1234-5678',
      text: 'Hi there',
      createdAt: '2026-01-01T00:00:02Z',
    },
    {
      id: 't3',
      speaker: 'human',
      identity: 'human:u1',
      text: 'Ann here',
      createdAt: '2026-01-01T00:00:03Z',
    },
  ],
  events: [{ id: 'e1', type: 'call.created', payload: {}, at: '2026-01-01T00:00:00Z' }],
};

/** The same call with the AI's routing tags and the escalation events. */
const routed: CallDetail = {
  ...detail,
  requiredSkills: ['vip', 'billing'],
  language: 'it',
  events: [
    ...detail.events,
    {
      id: 'e2',
      type: 'escalation.requested',
      payload: { reason: 'r', summary: 's', skills: ['vip'] },
      at: '2026-01-01T00:00:05Z',
    },
    {
      id: 'e3',
      type: 'escalation.relaxed',
      payload: { dropped: ['vip', 'billing'] },
      at: '2026-01-01T00:00:25Z',
    },
  ],
};

const segment = (text: string) => ({ speaker: 'ai' as const, identity: 'ai:1', text });

const renderPage = (desk: ReturnType<typeof useDeskSocket>, supervisor = true) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CallPage id={detail.id} desk={desk} supervisor={supervisor} />
    </QueryClientProvider>,
  );

describe('CallPage', () => {
  beforeEach(() => {
    mocks.api.mockReset().mockResolvedValue(detail);
    mocks.post.mockReset();
    location.hash = '#/calls/call-1234-5678';
  });
  afterEach(cleanup);

  it('shows details, merges stored and live transcript, navigates back', async () => {
    const desk = fakeDesk({
      transcripts: { [detail.id]: [segment('Hello'), segment('Live tail')] },
    });
    renderPage(desk, false);
    expect(desk.send).toHaveBeenCalledWith({ type: 'subscribe', callId: detail.id });
    expect(await screen.findByText('support')).toBeTruthy();
    expect(screen.getByText('Call call-123')).toBeTruthy();
    expect(screen.getByText('With AI')).toBeTruthy();
    expect(screen.getAllByText('Hello')).toHaveLength(1);
    expect(screen.getByText('Live tail')).toBeTruthy();
    expect(screen.getByText('Wants a refund')).toBeTruthy();
    expect(screen.getByText('call.created')).toBeTruthy();
    // speakers are labelled: AI, customer by call id, humans by name
    expect(screen.getAllByText('AI assistant')).toHaveLength(2);
    expect(screen.getByText('Customer call-123')).toBeTruthy();
    expect(screen.getByText('Ann · Agent')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Call call-123');
    // Agents never see the supervisor buttons.
    expect(screen.queryByText('Listen in')).toBeNull();
    await userEvent.click(screen.getByText('← Back'));
    expect(location.hash).toBe('#/history');
  });

  it('shows the routing skills and language and narrates the escalation events', async () => {
    mocks.api.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/desk/settings'
          ? { skills: [{ key: 'vip', label: 'VIP customers', description: '' }] }
          : routed,
      ),
    );
    renderPage(fakeDesk({}), false);
    expect(await screen.findByText('VIP customers')).toBeTruthy();
    expect(screen.getByText('billing')).toBeTruthy();
    expect(screen.getByText('Language: Italiano')).toBeTruthy();
    expect(screen.getByText('call.created')).toBeTruthy();
    expect(screen.getByText(/Escalation requested, skills: VIP customers/)).toBeTruthy();
    expect(screen.getByText(/Skill requirements relaxed: VIP customers, billing/)).toBeTruthy();
  });

  it('hides listen / take over once the call ended', async () => {
    renderPage(fakeDesk({ callStatus: { [detail.id]: 'ended' } }));
    expect(await screen.findByText('Ended')).toBeTruthy();
    expect(screen.queryByText('Listen in')).toBeNull();
  });

  it('lets a supervisor listen in and stop', async () => {
    mocks.post.mockResolvedValueOnce({ token: 'tok', url: 'wss://lk' }).mockResolvedValueOnce({});
    renderPage(fakeDesk({}));
    await userEvent.click(await screen.findByText('Listen in'));
    expect(mocks.post).toHaveBeenCalledWith(`/desk/calls/${detail.id}/join`, { mode: 'listen' });
    expect(await screen.findByText('Listening in')).toBeTruthy();
    await userEvent.click(screen.getByText('Leave'));
    await act(async () => {});
    expect(mocks.post).toHaveBeenLastCalledWith(`/desk/calls/${detail.id}/leave`, {
      role: 'supervisor',
    });
    expect(screen.queryByText('Listening in')).toBeNull();
    expect(screen.getByText('Listen in')).toBeTruthy();
  });

  it('keeps stored rows the socket never saw and appends only new live segments', async () => {
    // Opened mid-call: stored = [Hello]; live arrived later = [More, More] (said twice).
    renderPage(
      fakeDesk({ transcripts: { [detail.id]: [segment('More'), segment('More')] } }),
      false,
    );
    expect(await screen.findByText('Hello')).toBeTruthy();
    expect(screen.getAllByText('More')).toHaveLength(2);
  });

  it('lets a supervisor take over, tolerating a failing leave', async () => {
    mocks.post
      .mockResolvedValueOnce({ token: 'tok', url: 'wss://lk' })
      .mockRejectedValueOnce(new Error('gone'));
    renderPage(fakeDesk({ transcripts: { [detail.id]: [segment('Hello'), segment('More')] } }));
    await userEvent.click(await screen.findByText('Take over'));
    expect(mocks.post).toHaveBeenCalledWith(`/desk/calls/${detail.id}/join`, { mode: 'takeover' });
    expect(await screen.findByText('You took over this call')).toBeTruthy();
    expect(screen.getByText('Hello|Hi there|Ann here|More')).toBeTruthy();
    await userEvent.click(screen.getByText('Leave'));
    await act(async () => {});
    expect(mocks.post).toHaveBeenLastCalledWith(`/desk/calls/${detail.id}/leave`, {
      role: 'human',
    });
    expect(screen.getByText('Take over')).toBeTruthy();
  });
});
