/// <reference types="vitest" />
import { defineConfig } from 'vite';

// The campaign tables live at repo root in `campaigns/`, exactly where the
// design docs point. They are pulled in through `import.meta.glob` rather than
// a public directory, so there is no copy step and no second path to keep in
// sync. `fs.allow` lets the dev server read them from outside `src/`.
export default defineConfig({
  server: { fs: { allow: ['.'] } },
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
