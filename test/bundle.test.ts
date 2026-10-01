import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// An app bundling this library for the browser must not need any bundler
// configuration. The generated module's Node branch imports `node:module`, and
// a literal specifier there stops esbuild cold. Minified too, because the
// minifier folds constant expressions back into a literal.
describe("browser bundle", () => {
  for (const minify of [false, true]) {
    it(`bundles for the browser with no configuration${minify ? ", minified" : ""}`, async () => {
      const result = await build({
        entryPoints: ["src/index.ts"],
        bundle: true,
        format: "esm",
        platform: "browser",
        minify,
        write: false,
        logLevel: "silent",
      });

      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  }
});
