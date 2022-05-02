export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      !url.searchParams.has("key") ||
      url.searchParams.get("key") !== env.API_KEY
    ) {
      return new Response("Invalid API key", { status: 403 });
    }
    const urlToCache = url.searchParams.get("url");
    if (!urlToCache) {
      return new Response("Missing url parameter", { status: 400 });
    }
    let cachedResponse: R2ObjectBody | null;
    try {
      cachedResponse = await env.STATIC_CACHE.get(CACHE_KEY(urlToCache));
    } catch {
      cachedResponse = null;
    }
    if (cachedResponse) {
      const headers = new Headers();
      headers.set(
        "Content-Type",
        cachedResponse.httpMetadata.contentType || "text/plain"
      );
      headers.set(
        "Cache-Control",
        cachedResponse.httpMetadata.cacheControl || "public, max-age=86400"
      );
      headers.set(
        "Content-Disposition",
        cachedResponse.httpMetadata.contentDisposition || "inline"
      );
      if (cachedResponse.httpMetadata.contentEncoding) {
        headers.set(
          "Content-Encoding",
          cachedResponse.httpMetadata.contentEncoding
        );
      }
      return new Response(cachedResponse.body, {
        status: 200,
        headers: headers,
      });
    } else {
      const response = await fetch(urlToCache);

      const meta: R2HTTPMetadata = {
        cacheControl: "public, max-age=86400",
        contentType: response.headers.get("Content-Type") || "text/plain",
        contentDisposition: response.headers.get("Content-Disposition") || undefined,
        contentEncoding: response.headers.get("Content-Encoding") || undefined,
        contentLanguage: response.headers.get("Content-Language") || undefined,
      }
      if (response.ok) {
        await env.STATIC_CACHE.put(CACHE_KEY(urlToCache), response.body, {
          httpMetadata: meta
        });
      }
      return response;
    }
  },
};

/** Used adds a prefix to r2 cache keys */
const CACHE_KEY = (url: string) => `cache/${url}`;
