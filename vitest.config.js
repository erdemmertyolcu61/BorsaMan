import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.js', 'src/**/*.test.js'],
    globals: false,
    reporters: 'default',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        'src/utils/indicators.js',
        'src/utils/signals.js',
        'src/utils/SMC_Logic_Engine.js',
        'src/utils/backtestEngine.js',
        'src/utils/fundamentalEngine.js',
        'src/utils/sanitize.js',
        'src/utils/monteCarlo.js',
        'src/utils/errorLogger.js',
      ],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 40,
        statements: 40,
      },
    },
  },
});
