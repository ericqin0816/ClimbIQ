import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig(environment => mergeConfig(viteConfig(environment), {
  test: {
    // Local benchmark copies must not duplicate or replace the current tests.
    exclude: [...configDefaults.exclude, ".local-npm/**", "test-results/**", "ios/**"],
  },
}));
