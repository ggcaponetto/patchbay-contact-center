import type { CallStatus, TranscriptSegmentInput } from '@cc/shared';

export type EscalationOutcome = { outcome: 'accepted'; agentName: string } | { outcome: 'nobody' };

/** Minimal client for the API's `/api/internal` endpoints. Errors are logged, never thrown. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly callId: string;
  private readonly log: (msg: string) => void;

  constructor(baseUrl: string, secret: string, callId: string, log = console.error) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.callId = callId;
    this.log = log;
  }

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

  /** Asks for a human; resolves when someone accepted or nobody could (long-poll). */
  async escalate(reason: string, summary: string, ringSec: number): Promise<EscalationOutcome> {
    const res = (await this.post('/escalate', { reason, summary, ringSec })) as
      EscalationOutcome | undefined;
    return res ?? { outcome: 'nobody' };
  }

  async transcript(segment: TranscriptSegmentInput): Promise<void> {
    await this.post('/transcript', segment);
  }
  async event(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.post('/events', { type, payload });
  }
  async participant(kind: 'ai' | 'transcriber', identity: string, left = false): Promise<void> {
    await this.post('/participants', { kind, identity, left });
  }
  async status(status: CallStatus, summary?: string): Promise<void> {
    await this.post('/status', summary ? { status, summary } : { status });
  }
}
