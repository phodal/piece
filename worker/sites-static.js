/**
 * Serve the static Piece demo through the Sites Worker runtime.
 * Assets are emitted to dist/client by scripts/build-sites.mjs.
 */
export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const assetUrl = new URL(request.url);
    if (assetUrl.pathname === "/") {
      assetUrl.pathname = "/index.html";
    } else if (assetUrl.pathname.endsWith("/")) {
      assetUrl.pathname += "index.html";
    }

    return env.ASSETS.fetch(new Request(assetUrl, request));
  },
};
