/**
 * The `<cc-call-button>` custom element: the only thing a customer website embeds.
 *
 * A thin shell: it reads its attributes, mounts the React `CallButton` into an open
 * shadow root and re-renders when an attribute changes. The call logic is in
 * `useCall.ts`, the UI in `CallButton.tsx`. Registered as `cc-call-button` on load
 * (guarded so the script can be included twice).
 */
import { createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { CallButton, type CallButtonProps } from './CallButton.tsx';

// Captured at load time: `document.currentScript` is null once the script has finished.
const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src;

/**
 * `<cc-call-button key="pk_…" queue="support" api="https://api.example" label="Call us" language="de">`
 *
 * Starts a WebRTC call to the contact center when clicked.
 *
 * Attributes (live: changing one re-renders, and the next call uses the new value):
 * - `key`: public embed key (`pk_…`) created in the supervisor settings. Required.
 * - `queue`: queue key to ring; defaults to `support`.
 * - `api`: origin of the API; defaults to the origin of the loaded script.
 * - `label`: text of the call button; defaults to "Call us" in the customer's language.
 * - `language`: the customer's language (BCP 47); defaults to the page's `<html lang>`,
 *   then the browser's language. Picks the UI translation (en, de, it; anything else
 *   falls back to English) and is sent to the API for language routing.
 *
 * Network: `POST <api>/api/public/calls` with `{ embedKey, queue, language, customerMeta }`
 * and the browser-set `Origin` header, then `Room.connect(url, token)`. The response may
 * carry `sounds.ringback`, a URL looped while the customer is `waiting` for someone
 * (Settings → Sounds); without it, waiting is silent.
 */
export class CcCallButton extends HTMLElement {
  /** Attributes whose change triggers `attributeChangedCallback`. */
  static observedAttributes = ['key', 'queue', 'api', 'label', 'language'];
  private root: Root | undefined;
  private readonly shadow = this.attachShadow({ mode: 'open' });

  /** Custom element lifecycle: first paint. */
  connectedCallback(): void {
    this.root ??= createRoot(this.shadow);
    this.render();
  }

  /** Custom element lifecycle: unmount (the hook's cleanup leaves the room). */
  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = undefined;
  }

  /** Custom element lifecycle: re-render with the new attribute values. */
  attributeChangedCallback(): void {
    this.render();
  }

  /** Attributes → props. */
  private get props(): CallButtonProps {
    const attr = (name: string) => this.getAttribute(name);
    return {
      embedKey: attr('key') ?? '',
      queue: attr('queue') ?? 'support',
      api: attr('api') ?? new URL(scriptSrc ?? location.href).origin,
      label: attr('label') ?? undefined,
      language:
        attr('language') || document.documentElement.lang || navigator.language || undefined,
    };
  }

  private render(): void {
    this.root?.render(createElement(CallButton, this.props));
  }
}

if (!customElements.get('cc-call-button')) {
  customElements.define('cc-call-button', CcCallButton);
}
