import { type RemoteParticipant, type RemoteTrack, Room, RoomEvent, Track } from 'livekit-client';
import { type CallState, reduce, statusText } from './state.ts';

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
 */
export class CcCallButton extends HTMLElement {
  private state: CallState = { kind: 'idle' };
  private room: Room | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly root = this.attachShadow({ mode: 'open' });
  private readonly audio = document.createElement('div');

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    void this.room?.disconnect();
    if (this.timer) clearInterval(this.timer);
  }

  private get apiOrigin(): string {
    return this.getAttribute('api') ?? new URL(scriptSrc ?? location.href).origin;
  }

  private dispatch(event: Parameters<typeof reduce>[1]): void {
    this.state = reduce(this.state, event);
    this.render();
  }

  private async startCall(): Promise<void> {
    this.dispatch({ type: 'click' });
    try {
      const res = await fetch(`${this.apiOrigin}/api/public/calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          embedKey: this.getAttribute('key') ?? '',
          queue: this.getAttribute('queue') ?? 'support',
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
      room.remoteParticipants.forEach((p) => this.onPeer(p));
      this.timer = setInterval(() => this.render(), 1000);
    } catch (err) {
      this.dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      await this.endCall(false);
    }
  }

  private onPeer(p: RemoteParticipant): void {
    const role = p.attributes['role'];
    if (role) this.dispatch({ type: 'peer_joined', role, name: p.name || undefined });
  }

  private async endCall(byUser: boolean): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const room = this.room;
    this.room = undefined;
    this.audio.replaceChildren();
    await room?.disconnect();
    this.dispatch({ type: byUser ? 'hangup' : 'disconnected' });
  }

  private async toggleMute(): Promise<void> {
    this.dispatch({ type: 'toggle_mute' });
    if (this.state.kind === 'in_call') {
      await this.room?.localParticipant.setMicrophoneEnabled(!this.state.muted);
    }
  }

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

function button(text: string, cls: string, onClick: () => unknown): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = cls;
  b.addEventListener('click', () => void onClick());
  return b;
}

const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src;

if (!customElements.get('cc-call-button')) {
  customElements.define('cc-call-button', CcCallButton);
}
