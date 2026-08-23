// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageCenter } from './MessageCenter.tsx';

const msg = (text: string, broadcast = false) => ({
  from: { userId: 'u1', name: 'Boss' },
  text,
  broadcast,
});

describe('MessageCenter', () => {
  afterEach(cleanup);

  it('shows the ticker banner only when set', () => {
    const { rerender } = render(<MessageCenter state={{ ticker: '', messages: [] }} />);
    expect(screen.queryByTestId('ticker')).toBeNull();
    rerender(<MessageCenter state={{ ticker: 'All hands at 3', messages: [] }} />);
    expect(screen.getByTestId('ticker').textContent).toContain('All hands at 3');
  });

  it('pops the latest message, labels broadcasts, and re-opens on a new one', async () => {
    const { rerender } = render(<MessageCenter state={{ ticker: '', messages: [msg('hello')] }} />);
    expect(screen.getByText('Boss:', { exact: false }).textContent).toContain('hello');
    await userEvent.keyboard('{Escape}');
    rerender(
      <MessageCenter state={{ ticker: '', messages: [msg('hello'), msg('urgent', true)] }} />,
    );
    expect(screen.getByText('Boss (to everyone):', { exact: false }).textContent).toContain(
      'urgent',
    );
  });
});
