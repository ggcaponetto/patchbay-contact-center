/**
 * Scoped styles of the call button, injected as a `<style>` into the shadow root so they
 * neither leak into nor inherit from the host page. Colors follow the host page's
 * `prefers-color-scheme`, buttons are at least 44px tall and keyboard focus is visible.
 */

/** The whole stylesheet; `:host` is the `<cc-call-button>` element itself. */
export const styles = `
  :host { display: inline-block; font: 14px/1.4 system-ui, -apple-system, Roboto, sans-serif;
    color: #111; --cc-primary: #1d4ed8; --cc-danger: #b91c1c; --cc-secondary: #e5e7eb;
    --cc-secondary-text: #111; --cc-status: #444; --cc-ring: #1d4ed8; }
  @media (prefers-color-scheme: dark) {
    :host { color: #f3f4f6; --cc-primary: #3b82f6; --cc-danger: #dc2626; --cc-secondary: #374151;
      --cc-secondary-text: #f3f4f6; --cc-status: #d1d5db; --cc-ring: #93c5fd; }
  }
  button { cursor: pointer; border: 0; border-radius: 999px; min-height: 44px; padding: 10px 20px;
    font: inherit; font-weight: 600; color: #fff; background: var(--cc-primary);
    transition: filter 120ms ease; }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  button:focus-visible { outline: 3px solid var(--cc-ring); outline-offset: 2px; }
  button:disabled { opacity: .6; cursor: default; }
  button.danger { background: var(--cc-danger); }
  button.secondary { background: var(--cc-secondary); color: var(--cc-secondary-text); }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .status { margin-top: 6px; color: var(--cc-status); min-height: 1.4em; }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;
