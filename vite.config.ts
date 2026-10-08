import { defineConfig } from 'vitest/config';

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Worklets are bundled as standalone ES modules (loaded with audioWorklet.addModule).
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  server: { headers: isolation },
  preview: { headers: isolation },
  test: { include: ['tests/*.test.ts'], environment: 'node' },
});
