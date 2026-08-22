// @vitest-environment jsdom
import { useQueryClient } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The real App needs a session; a probe that reports the query client is enough to prove
// the provider tree is wired.
vi.mock('./App.tsx', () => ({
  App: () => {
    const qc = useQueryClient();
    return <div>app retry={String(qc.getDefaultOptions().queries?.retry)}</div>;
  },
}));

describe('main', () => {
  it('mounts the app with its providers into #root', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await act(async () => {
      await import('./main.tsx');
    });
    expect(screen.getByText('app retry=1')).toBeTruthy();
    expect(root.contains(screen.getByText('app retry=1'))).toBe(true);
  });
});
