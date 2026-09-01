import type { Env as AppEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}

export {};
