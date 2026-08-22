/**
 * HTTP client for the API's internal endpoints (`/api/internal/calls/:id/*`).
 *
 * The agent worker has no database; everything it learns about a call (transcript lines,
 * events, participant changes, escalation requests, the final status and summary) is
 * reported to the API through this class. The API authenticates requests with the
 * `x-internal-secret` header (see `apps/api/src/routes/internal.ts`).
 *
 * Design choice: every method swallows errors and logs them. A failing API call must
 * never crash or stall a live voice conversation; the worst case is a missing transcript
 * line on the desk.
 *
 * @see apps/agent/README.md
 * @packageDocumentation
 */
import type { CallStatus, TranscriptSegmentInput } from '@cc/shared';

/**
 * Result of an escalation long-poll (mirrors `Outcome` in `apps/api/src/flow.ts`).
 *
 * - `accepted`: a human clicked "accept"; `agentName` is their display name, used in the
 *   sentence the AI says to the caller.
 * - `nobody`: every available agent declined or timed out, the call ended meanwhile, or
 *   the request itself failed.
 */
export type EscalationOutcome = { outcome: 'accepted'; agentName: string } | { outcome: 'nobody' };

/**
 * Minimal client for the API's `/api/internal` endpoints. Errors are logged, never thrown.
 *
 * One instance per job, bound to a single call id.
 *
 * @example
 * ```ts
 * const api = new ApiClient('http://localhost:4000', process.env.INTERNAL_API_SECRET!, callId);
 * await api.event('ai.joined');
 * await api.transcript({ speaker: 'ai', identity: `ai:${callId}`, text: 'Hello!' });
 * ```
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly callId: string;
  private readonly log: (msg: string) => void;

  /**
   * @param baseUrl - Origin of the API, for example `http://localhost:4000` (`API_ORIGIN`).
   * @param secret - Value of `INTERNAL_API_SECRET`, sent as `x-internal-secret`.
   * @param callId - Call this client reports on; becomes part of every URL.
   * @param log - Sink for failures; defaults to `console.error`, tests pass a spy.
   */
  constructor(baseUrl: string, secret: string, callId: string, log = console.error) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.callId = callId;
    this.log = log;
  }

  /** POSTs JSON to `/api/internal/calls/:id<path>`; returns the parsed body or `undefined` on any failure. */
  private async post(path: string, body: unknown): Promise<unknown> {
    try {
      const res = await fetch(`${this.baseUrl}/api/internal/calls/${this.callId}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.log(`api ${path} -> ${res.status} ${await res.text()}`);
        return undefined;
      }
      return await res.json();
    } catch (err) {
      this.log(`api ${path} failed: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Asks for a human; resolves when someone accepted or nobody could (long-poll).
   *
   * The API sets the call to `waiting_human`, rings the queue's agents one at a time and
   * only answers this request once the outcome is known, so the promise can stay pending
   * for `ringSec` × (number of agents) seconds. Any transport error maps to `nobody`.
   *
   * @param reason - Why the caller needs a human (shown on the desk offer).
   * @param summary - Conversation so far (shown on the desk offer).
   * @param ringSec - Seconds each agent's offer rings; usually `TenantSettings.offerTimeoutSec`.
   */
  async escalate(reason: string, summary: string, ringSec: number): Promise<EscalationOutcome> {
    const res = (await this.post('/escalate', { reason, summary, ringSec })) as
      EscalationOutcome | undefined;
    return res ?? { outcome: 'nobody' };
  }

  /** Stores one transcript line and pushes it to desks subscribed to the call. */
  async transcript(segment: TranscriptSegmentInput): Promise<void> {
    await this.post('/transcript', segment);
  }
  /**
   * Appends an audit event to the call's timeline (for example `ai.joined`, `handoff`,
   * `call.ended_by_ai`). Free-form; the API only stores it.
   */
  async event(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.post('/events', { type, payload });
  }
  /**
   * Registers the worker's own participant row, or marks it as left.
   *
   * The worker is `ai` while it speaks and becomes `transcriber` after a `leave` handoff;
   * the API only accepts those two kinds here (humans and customers are registered by the
   * API itself).
   *
   * @param kind - `ai` or `transcriber`.
   * @param identity - LiveKit identity, always `ai:<callId>` for this worker.
   * @param left - `true` to mark the participant as gone instead of adding it.
   */
  async participant(kind: 'ai' | 'transcriber', identity: string, left = false): Promise<void> {
    await this.post('/participants', { kind, identity, left });
  }
  /**
   * Updates the call status and optionally stores the summary. Sending `ended` makes the
   * API delete the LiveKit room and resolve any pending escalation with `nobody`.
   */
  async status(status: CallStatus, summary?: string): Promise<void> {
    await this.post('/status', summary ? { status, summary } : { status });
  }
}
