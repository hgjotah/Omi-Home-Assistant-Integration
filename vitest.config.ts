import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_SECRET: "test-app-secret-that-is-at-least-32-bytes-long",
          OMI_WEBHOOK_TOKEN: "test-omi-webhook-token-32-bytes-long",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./tests/apply-migrations.ts"],
    testTimeout: 15_000,
  },
});
