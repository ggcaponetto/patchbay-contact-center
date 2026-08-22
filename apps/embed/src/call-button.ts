/**
 * The `<cc-call-button>` custom element: the only thing a customer website embeds.
 *
 * Responsibilities: read its attributes, create the call through the public API, join
 * the LiveKit room with the returned token, publish the microphone, play whatever audio
 * the room sends back, and render a tiny shadow-DOM UI driven by the state machine in
 * `state.ts`. Registered as `cc-call-button` on load (guarded so the script can be
 * included twice).
 */
import { type RemoteParticipant, type RemoteTrack, Room, RoomEvent, Track } from 'livekit-client';
import { type CallState, reduce, statusText } from './state.ts';

/** Scoped styles; the shadow root keeps them from leaking into or out of the host page. */
const styles = `
  :host { display: inline-block; font: 14px/1.4 system-ui, sans-serif; color: #111; }
  button { cursor: pointer; border: 0; border-radius: 999px; padding: 10px 18px; font: inherit;
    font-weight: 600; color: #fff; background: #1d4ed8; }
  button:disabled { opacity: .6; cursor: default; }
  button.danger { background: #b91c1c; }
  button.secondary { background: #e5e7eb; color: #111; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .status { margin-top: 6px; color: #444; min-height: 1.4em; }
`;

/**
 * `<cc-call-button key="pk_…" queue="support" api="https://api.example" label="Call us">`
 *
 * Starts a WebRTC call to the contact center when clicked. The API origin
 * defaults to the origin the script was loaded from.
 *
 * Attributes (read on every use, so they can be changed before the first click):
 * - `key`: public embed key (`pk_…`) created in the supervisor settings. Required.
 * - `queue`: queue key to ring; defaults to `support`.
 * - `api`: origin of the API; defaults to the origin of the loaded script.
 * - `label`: text of the call button; defaults to "Call us".
 * - `language`: the customer's language (BCP 47); defaults to the page's `<html lang>`.
 *
 * Network: `POST <api>/api/public/calls` with `{ embedKey, queue, customerMeta }` and
 * the browser-set `Origin` header, then `Room.connect(url, token)`.
 */
export class CcCallButton extends HTMLElement {
  /** Current machine state; only changed through {@link dispatch}. */
  private state: CallState = { kind: 'idle' };
  private room: Room | undefined;
  /** Re-renders every second during a call so the duration ticks. */
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly root = this.attachShadow({ mode: 'open' });
  /** Holder for the `<audio>` elements created by `track.attach()`; lives across renders. */
  private readonly audio = document.createElement('div');

  /** Custom element lifecycle: first paint. */
  connectedCallback(): void {
    this.render();
  }

  /** Custom element lifecycle: leave the room if the element is removed mid-call. */
  disconnectedCallback(): void {
    void this.room?.disconnect().catch(() => undefined);
    if (this.timer) clearInterval(this.timer);
  }

  /** `api` attribute, or where this script came from (so the snippet works without `api`). */
  private get apiOrigin(): string {
    return this.getAttribute('api') ?? new URL(scriptSrc ?? location.href).origin;
  }

  /** Runs the reducer and repaints. */
  private dispatch(event: Parameters<typeof reduce>[1]): void {
    this.state = reduce(this.state, event);
    this.render();
  }

  /**
   * Click handler of the call button. Creates the call, joins the room and enables the
   * microphone. Any failure (HTTP error, refused origin, mic permission) lands in the
   * `error` state and tears the room down.
   */
  private async startCall(): Promise<void> {
    this.dispatch({ type: 'click' });
    try {
      const embedKey = this.getAttribute('key') ?? '';
      if (!embedKey) throw new Error('the key attribute is missing (create one in Settings)');
      const res = await fetch(`${this.apiOrigin}/api/public/calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          embedKey,
          queue: this.getAttribute('queue') ?? 'support',
          // The customer's language, from the attribute or the page, for language routing.
          language: this.getAttribute('language') || document.documentElement.lang || undefined,
          customerMeta: { page: location.href, userAgent: navigator.userAgent },
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      const { token, url } = (await res.json()) as { token: string; url: string };
      const room = new Room();
      this.room = room;
      room
        .on(RoomEvent.ParticipantConnected, (p) => this.onPeer(p))
        .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
          if (!p.isLocal) this.onPeer(p as RemoteParticipant);
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) this.audio.append(track.attach());
        })
        .on(RoomEvent.Disconnected, () => this.endCall(false));
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      this.dispatch({ type: 'connected', at: Date.now() });
      // The AI is dispatched with the customer's token and is often already in the room
      // by the time `connect` resolves, so no `ParticipantConnected` event fires for it.
      // Events that did fire before `connected` were ignored by the reducer (state was
      // still `connecting`), so re-announce every present peer now.
      room.remoteParticipants.forEach((p) => this.onPeer(p));
      this.timer = setInterval(() => this.render(), 1000);
    } catch (err) {
      this.dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      await this.endCall(false);
    }
  }

  /**
   * A remote participant appeared or changed attributes. The `role` attribute is set
   * by the API (token) or by the AI agent on itself, possibly after it joined, which
   * is why `ParticipantAttributesChanged` also routes here.
   */
  private onPeer(p: RemoteParticipant): void {
    const role = p.attributes['role'];
    if (role) this.dispatch({ type: 'peer_joined', role, name: p.name || undefined });
  }

  /** Leaves the room and moves to `ended` (`hangup` when the customer clicked, else `disconnected`). */
  private async endCall(byUser: boolean): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const room = this.room;
    this.room = undefined;
    this.audio.replaceChildren();
    await room?.disconnect();
    this.dispatch({ type: byUser ? 'hangup' : 'disconnected' });
  }

  /** Mute/unmute the microphone; the reducer decides whether it applies. */
  private async toggleMute(): Promise<void> {
    this.dispatch({ type: 'toggle_mute' });
    if (this.state.kind === 'in_call') {
      await this.room?.localParticipant.setMicrophoneEnabled(!this.state.muted);
    }
  }

  /** Rebuilds the shadow DOM from scratch; cheap enough for a few elements. */
  private render(): void {
    const s = this.state;
    const inCall = s.kind === 'in_call' || s.kind === 'waiting';
    const label = this.getAttribute('label') ?? 'Call us';
    this.root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = styles;
    const row = document.createElement('div');
    row.className = 'row';
    if (inCall) {
      const mute = button(s.kind === 'in_call' && s.muted ? 'Unmute' : 'Mute', 'secondary', () =>
        this.toggleMute(),
      );
      const hangup = button('Hang up', 'danger', () => this.endCall(true));
      row.append(mute, hangup);
    } else {
      const call = button(label, '', () => this.startCall());
      call.disabled = s.kind === 'connecting';
      row.append(call);
    }
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = statusText(s, Date.now());
    this.root.append(style, row, status, this.audio);
  }
}

/** Small factory for the styled buttons; `cls` is one of `''`, `secondary`, `danger`. */
function button(text: string, cls: string, onClick: () => unknown): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = cls;
  b.addEventListener('click', () => void onClick());
  return b;
}

// Captured at load time: `document.currentScript` is null once the script has finished.
const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src;

if (!customElements.get('cc-call-button')) {
  customElements.define('cc-call-button', CcCallButton);
}
