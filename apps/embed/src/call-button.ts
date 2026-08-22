/** `<cc-call-button>`: placeholder registered in phase 1, implemented in phase 3. */
export class CcCallButton extends HTMLElement {
  connectedCallback(): void {
    const root = this.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = this.getAttribute('label') ?? 'Call us';
    root.append(button);
  }
}

if (!customElements.get('cc-call-button')) {
  customElements.define('cc-call-button', CcCallButton);
}
