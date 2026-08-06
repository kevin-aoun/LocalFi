import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit-test harness for the pure primitives in lib/.
 *
 * NOTE: timezone-sensitive tests must be run with the TZ environment variable
 * set on the *process* (see the `test:tz` npm script). Node reads TZ once at
 * process start, so stubbing it inside a test has no effect on `new Date(...)`.
 */
export default defineConfig({
  resolve: {
    // Mirror the "@/*" path alias from tsconfig.json.
    alias: [{ find: /^@\//, replacement: `${path.resolve(__dirname)}/` }],
  },
  test: {
    environment: "node",
    include: ["{lib,app,components,eval,scripts}/**/__tests__/**/*.test.ts"],
    reporters: ["default"],
  },
});
