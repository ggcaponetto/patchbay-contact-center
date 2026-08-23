/**
 * Scoped styles of the call button, injected as a `<style>` into the shadow root so they
 * neither leak into nor inherit from the host page.
 */

/** The whole stylesheet; `:host` is the `<cc-call-button>` element itself. */
export const styles = `
  :host { display: inline-block; font: 14px/1.4 system-ui, sans-serif; color: #111; }
  button { cursor: pointer; border: 0; border-radius: 999px; padding: 10px 18px; font: inherit;
    font-weight: 600; color: #fff; background: #1d4ed8; }
  button:disabled { opacity: .6; cursor: default; }
  button.danger { background: #b91c1c; }
  button.secondary { background: #e5e7eb; color: #111; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .status { margin-top: 6px; color: #444; min-height: 1.4em; }
`;
