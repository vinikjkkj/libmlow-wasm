/**
 * Emscripten's `ENVIRONMENT=web,node` output reaches Node's builtins through
 * `await import("node:module")`, inside a branch only Node runs. Bundlers
 * resolve a string-literal `import()` wherever it sits, so a browser build of
 * an app using this library fails on it: esbuild stops with `Could not resolve
 * "node:module"`, webpack with an unhandled `node:` scheme.
 *
 * The specifier is rewritten into an expression only the runtime can evaluate,
 * which every bundler leaves alone. It has to be a runtime value: esbuild's
 * minifier folds anything constant, `"node:module".toString()` included, back
 * into a literal and fails again. In Node it evaluates to the same specifier.
 */
const LITERAL_NODE_IMPORT = /\bimport\(\s*(["'])(node:[\w/]+)\1\s*\)/g;
const STATIC_NODE_IMPORT = /\bfrom\s*["']node:|\bimport\s*["']node:/;

export function hideNodeImportsFromBundlers(source) {
  const rewritten = source.replace(
    LITERAL_NODE_IMPORT,
    (_, _quote, specifier) =>
      `import(/* webpackIgnore: true */ /* @vite-ignore */ globalThis.process?.versions?.node && "${specifier}")`,
  );
  if (rewritten.search(LITERAL_NODE_IMPORT) !== -1 || STATIC_NODE_IMPORT.test(rewritten)) {
    throw new Error("generated module still imports a node: builtin that bundlers will try to resolve");
  }
  return rewritten;
}
