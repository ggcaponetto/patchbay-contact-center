// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallNotes } from './CallNotes.tsx';

const post = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.ts', () => ({ post }));

describe('CallNotes', () => {
  beforeEach(() => post.mockReset().mockResolvedValue({ ok: true }));
  afterEach(cleanup);

  it('adds a note (clearing the field) and saves the parsed tag list', async () => {
    render(<CallNotes callId="c1" tags={['vip']} />);
    expect((screen.getByRole('button', { name: 'Add note' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.type(screen.getByLabelText('Note'), 'Caller upset');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(post).toHaveBeenCalledWith('/desk/calls/c1/note', { text: 'Caller upset' });
    expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('');

    const tags = screen.getByLabelText('Tags (comma separated)') as HTMLInputElement;
    expect(tags.value).toBe('vip');
    await userEvent.clear(tags);
    await userEvent.type(tags, ' vip , complaint ,, ');
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/tags', { tags: ['vip', 'complaint'] });
  });

  it('reports failures through onError', async () => {
    post.mockRejectedValueOnce(new Error('not_found'));
    const onError = vi.fn();
    render(<CallNotes callId="c1" onError={onError} />);
    await userEvent.type(screen.getByLabelText('Note'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(onError).toHaveBeenCalledWith('not_found');
  });
});
