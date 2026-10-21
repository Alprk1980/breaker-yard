import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The allocation test reads V8 GC events; --expose-gc lets it start from a clean heap.
    execArgv: ['--expose-gc'],
  },
});
