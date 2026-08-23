// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import de from '../locales/de/translation.json';
import { createWebI18n } from './i18n.ts';
import { ToastProvider, errorText, useToast } from './useToast.tsx';

function Demo() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast('Saved')}>ok</button>
      <button onClick={() => toast('Nope', 'error')}>fail</button>
    </>
  );
}

describe('useToast', () => {
  afterEach(cleanup);

  it('shows success and error toasts and closes them', async () => {
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText('ok'));
    expect(screen.getByRole('status').textContent).toContain('Saved');
    await userEvent.click(screen.getByText('fail'));
    expect(screen.getByRole('status').textContent).toContain('Nope');
    expect(screen.getByRole('status').className).toContain('Error');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => undefined);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is a no-op without a provider', async () => {
    render(<Demo />);
    await userEvent.click(screen.getByText('ok'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('strips the Error prefix of failed requests', () => {
    expect(errorText(new Error('invalid_body'))).toBe('invalid_body');
    expect(errorText('Error: x')).toBe('x');
    expect(errorText('')).toBe('Something went wrong');
  });

  it('translates known API error codes, leaves unknown ones as they are', () => {
    const i18n = createWebI18n('de');
    expect(errorText(new Error('on_call'), i18n)).toBe(de.errors.on_call);
    expect(errorText(new Error('Error: last_queue'), i18n)).toBe(de.errors.last_queue);
    expect(errorText(new Error('weird_code'), i18n)).toBe('weird_code');
    expect(errorText('', i18n)).toBe(de.errors.generic);
  });
});
