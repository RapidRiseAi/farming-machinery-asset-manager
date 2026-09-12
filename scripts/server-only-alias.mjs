// Resolve the bare `server-only` / `client-only` markers to an empty module.
//
// A real file rather than a `data:` URL: chained loaders (tsx) reject the data scheme with
// ERR_UNSUPPORTED_ESM_URL_SCHEME.
//
// See server-only-shim.mjs for why this is a loader and not a stub in node_modules.
export async function resolve(specifier, context, next) {
  if (specifier === "server-only" || specifier === "client-only") {
    return {
      url: new URL("./server-only-empty.mjs", import.meta.url).href,
      format: "module",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
