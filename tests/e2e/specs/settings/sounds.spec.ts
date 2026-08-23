/**
 * Sounds: a supervisor uploads a WAV in Settings → Sounds, it is listed, streams from its
 * public URL, becomes the tenant's hold music, and a queue's own hold-music URL survives
 * a routing save (nothing silently resets).
 */
import { API_ORIGIN } from '../../../../playwright.config.ts';
import { SettingsPage, admin, expect, test } from '../../support/fixtures.ts';

/** A tiny valid 16-bit mono WAV: `seconds` of a 440 Hz sine at 8 kHz. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test(
  'an uploaded WAV becomes the hold music and a queue override survives a routing save',
  { tag: ['@core', '@settings', '@E2E-52'] },
  async ({ page, request, supervisor, unique }) => {
    const settings = new SettingsPage(page);
    await settings.goto('sounds');
    const name = `${unique('jingle')}.wav`;
    await page
      .getByLabel('Upload hold music')
      .setInputFiles({ name, mimeType: 'audio/wav', buffer: wav(1) });
    await expect(settings.toast).toContainText(`${name} uploaded`);
    const url = await page.getByLabel('Hold music URL').inputValue();
    expect(url).toMatch(/^\/api\/public\/media\/[0-9a-f-]+$/);
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    // public, cacheable, the right type
    const res = await request.get(`${API_ORIGIN}${url}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('audio/wav');
    expect((await res.body()).subarray(0, 4).toString()).toBe('RIFF');

    await page.getByRole('button', { name: 'Save sounds' }).click();
    await expect(settings.toast).toContainText('Sounds saved');
    await expect
      .poll(async () => (await admin(supervisor.request).tenant()).settings.sounds)
      .toEqual({ holdMusic: url });

    // per-queue override, saved together with the routing fields
    await settings.tab('queues');
    const support = (await admin(supervisor.request).queues()).find((q) => q.key === 'support')!;
    const card = settings.queueCard('Support');
    await card.getByLabel('Hold music URL for Support (WAV, optional)').fill(url);
    await card.getByLabel('Hold music style').click();
    await page.getByRole('option', { name: 'Bright' }).click();
    await page.getByRole('button', { name: 'Save routing of Support' }).click();
    await expect(settings.toast).toContainText('Routing of Support saved');
    await expect
      .poll(
        async () =>
          (await admin(supervisor.request).queues()).find((q) => q.id === support.id)!.config,
      )
      .toMatchObject({ holdMusicUrl: url, moh: 'bright', algorithm: 'longest_idle' });

    // clean up: clear the sounds and the override, delete the file
    await admin(supervisor.request).updateSettings({ sounds: {} });
    await admin(supervisor.request).setQueueConfig(support.id, {
      algorithm: 'longest_idle',
      requiredSkills: [],
      languageRouting: false,
    });
    await settings.tab('sounds');
    await page.getByRole('button', { name: `delete file ${name}` }).click();
    await settings.confirm();
    await expect(settings.toast).toContainText('File deleted');
    expect((await request.get(`${API_ORIGIN}${url}`)).status()).toBe(404);
  },
);
