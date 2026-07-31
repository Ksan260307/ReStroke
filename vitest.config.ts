import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 解析・生成は決定論なので再試行は不要。失敗はそのまま出す。
    retry: 0,
    testTimeout: 30000,
  },
});
