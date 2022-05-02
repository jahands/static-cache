import sha1 from "sha1";

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
    const urlSha1 = sha1(urlToCache);

    console.log("urlSha1: ", urlSha1);
    let cachedResponse: R2ObjectBody | null;
    try {
      cachedResponse = await env.STATIC_CACHE.get(
        CACHE_KEY(urlToCache, urlSha1)
      );
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
        cachedResponse.httpMetadata.cacheControl || "public, max-age=604800" // 1 week
      );
      headers.set(
        "Content-Disposition",
        cachedResponse.httpMetadata.contentDisposition || "inline"
      );
      console.log(
        "disposition ",
        cachedResponse.httpMetadata.contentDisposition
      );
      if (cachedResponse.httpMetadata.contentEncoding) {
        headers.set(
          "Content-Encoding",
          cachedResponse.httpMetadata.contentEncoding
        );
      }
      headers.set("X-R2-Cache-Hit", "true");
      headers.set("Content-Length", cachedResponse.size.toString());
      return new Response(cachedResponse.body, {
        status: 200,
        headers: headers,
      });
    } else {
      const response = await fetch(urlToCache);

      const meta: R2HTTPMetadata = {
        cacheControl: "public, max-age=604800", // 1 week
        contentType: response.headers.get("Content-Type") || "text/plain",
        contentDisposition:
          response.headers.get("Content-Disposition") || undefined,
        contentEncoding: response.headers.get("Content-Encoding") || undefined,
        contentLanguage: response.headers.get("Content-Language") || undefined,
      };
      if (response.ok) {
        await env.STATIC_CACHE.put(
          CACHE_KEY(urlToCache, urlSha1),
          response.clone().body,
          {
            httpMetadata: meta,
            customMetadata: {
              url: urlToCache,
              url_sha1: urlSha1,
            },
          }
        );
      }
      return response;
    }
  },
};

/** Used adds a prefix to r2 cache keys */

function CACHE_KEY(url: string, hash: string) {
  // 1024 is the max length of a key in the S3 spec
  return `cache/${url}`.slice(0, 1024 - hash.length - 7) + "--sha1=" + hash;
}
