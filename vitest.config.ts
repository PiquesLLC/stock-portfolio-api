import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './src',
    include: ['**/__tests__/**/*.test.ts'],
    setupFiles: ['./__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['services/auth.service.ts', 'middleware/auth.middleware.ts', 'controllers/auth.controller.ts'],
    },
  },
});
