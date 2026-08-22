import type { CallStatus, TranscriptSegmentInput } from '@cc/shared';

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

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/internal/calls/${this.callId}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.log(`api ${path} -> ${res.status} ${await res.text()}`);
    } catch (err) {
      this.log(`api ${path} failed: ${String(err)}`);
    }
  }

  transcript(segment: TranscriptSegmentInput) {
    return this.post('/transcript', segment);
  }
  event(type: string, payload: Record<string, unknown> = {}) {
    return this.post('/events', { type, payload });
  }
  participant(kind: 'ai' | 'transcriber', identity: string, left = false) {
    return this.post('/participants', { kind, identity, left });
  }
  status(status: CallStatus, summary?: string) {
    return this.post('/status', summary ? { status, summary } : { status });
  }
}
