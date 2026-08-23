/**
 * Desk sounds: the zip tone of auto-answered calls and the ringtone of an incoming
 * offer. Both are synthesized with WebAudio unless the tenant configured a ringtone URL
 * (Settings → Sounds), in which case a looping `<audio>` element plays it.
 *
 * Browsers only let a page start audio after a user gesture; on the desk that gesture is
 * the click on "Ready", which always precedes the first offer. Should playback still be
 * refused (a tab opened straight into an offer), the failure is swallowed — the dialog
 * is the source of truth, the sound a courtesy. Everything is a no-op without WebAudio
 * (jsdom), so the rest of the desk stays testable.
 */
import { useEffect } from 'react';

/** The zip tone announcing an auto-answered call: a short 880 Hz beep. */
export function zipTone(): void {
  if (typeof AudioContext === 'undefined') return;
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.2;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
  osc.onended = () => void ctx.close();
}

/** Cadence of the built-in ring: two tones for 1.2 s, silence until the 4 s mark. */
const RING_ON_SEC = 1.2;
const RING_PERIOD_SEC = 4;

/**
 * Starts the built-in ringtone (a North-American style 440 + 480 Hz double tone on a
 * 1.2 s on / 2.8 s off cadence) and returns the function that stops it.
 */
export function startSynthRing(): () => void {
  if (typeof AudioContext === 'undefined') return () => undefined;
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  for (const hz of [440, 480]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    osc.connect(gain);
    osc.start();
  }
  // Schedule a few periods ahead and keep topping up while ringing.
  let until = ctx.currentTime;
  const schedule = () => {
    while (until < ctx.currentTime + RING_PERIOD_SEC * 2) {
      gain.gain.setValueAtTime(0.15, until);
      gain.gain.setValueAtTime(0, until + RING_ON_SEC);
      until += RING_PERIOD_SEC;
    }
  };
  schedule();
  const timer = setInterval(schedule, RING_PERIOD_SEC * 1000);
  return () => {
    clearInterval(timer);
    void ctx.close();
  };
}

/** Starts a looping `<audio>` for `url` and returns the function that stops it. */
export function startUrlRing(url: string): () => void {
  const el = new Audio(url);
  el.loop = true;
  el.play().catch(() => undefined);
  return () => {
    el.pause();
    el.removeAttribute('src');
  };
}

/**
 * Plays the ringtone while `active` is true: the tenant's `url` if set, the built-in
 * ring otherwise. Stops (and restarts on a new URL) whenever the inputs change.
 */
export function useRingtone(active: boolean, url: string | undefined): void {
  useEffect(() => {
    if (!active) return;
    return url ? startUrlRing(url) : startSynthRing();
  }, [active, url]);
}
