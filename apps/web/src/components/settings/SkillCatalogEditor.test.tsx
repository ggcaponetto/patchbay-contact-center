// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillCatalogEditor, keyOf, validKey } from './SkillCatalogEditor.tsx';

describe('SkillCatalogEditor', () => {
  afterEach(cleanup);

  it('derives keys from labels and validates them', () => {
    expect(keyOf('VIP customers')).toBe('vip-customers');
    expect(keyOf('  Billing / Refunds!  ')).toBe('billing-refunds');
    expect(keyOf('x'.repeat(50))).toHaveLength(40);
    expect(validKey('vip-2')).toBe(true);
    expect(validKey('-vip')).toBe(false);
    expect(validKey('VIP')).toBe(false);
    expect(validKey('')).toBe(false);
  });

  it('adds rows, keeps the key in step with the label until edited, and removes', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SkillCatalogEditor value={[]} onChange={onChange} />);
    expect(screen.getByText(/No routing skills yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '+ Add skill' }));
    expect(onChange).toHaveBeenLastCalledWith([{ key: '', label: '', description: '' }]);

    rerender(
      <SkillCatalogEditor value={[{ key: '', label: '', description: '' }]} onChange={onChange} />,
    );
    expect(screen.getByText('Lowercase letters, digits and dashes only')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Label'), 'V');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'v', label: 'V', description: '' }]);

    // once the key was edited by hand it no longer follows the label
    rerender(
      <SkillCatalogEditor
        value={[{ key: 'custom', label: 'VIP', description: '' }]}
        onChange={onChange}
      />,
    );
    await userEvent.type(screen.getByLabelText('Label'), 's');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'custom', label: 'VIPs', description: '' }]);
    await userEvent.type(screen.getByLabelText('Key'), '2');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'custom2', label: 'VIP', description: '' }]);
    await userEvent.type(screen.getByLabelText(/Description/), 'Gold members');
    expect(onChange).toHaveBeenCalledWith([{ key: 'custom', label: 'VIP', description: 'G' }]);
    expect(screen.queryByText('Lowercase letters, digits and dashes only')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'remove skill VIP' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
