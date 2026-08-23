// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from './ConfirmButton.tsx';

describe('ConfirmButton', () => {
  afterEach(cleanup);

  it('runs the action only after confirming', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        title="Delete queue?"
        message="Gone for good."
        confirmLabel="Yes, delete"
        onConfirm={onConfirm}
      >
        Delete
      </ConfirmButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Gone for good.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Gone for good.')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('defaults the confirm label to Delete', async () => {
    render(
      <ConfirmButton title="t" message="m" onConfirm={() => undefined}>
        Remove
      </ConfirmButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('renders as an icon button', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        icon
        aria-label="delete Shop"
        title="t"
        message="m"
        confirmLabel="Yes"
        onConfirm={onConfirm}
      >
        x
      </ConfirmButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'delete Shop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
