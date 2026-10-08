import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const wav = join(process.cwd(), 'test-results', 'clicks.wav');
mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
execFileSync(process.execPath, [join(process.cwd(), 'tests/e2e/make-clicks.mjs'), wav]);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: {
    command: 'npx wrangler dev --port 8787 --ip 127.0.0.1',
    url: 'http://127.0.0.1:8787/',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
});
