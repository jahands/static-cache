import sha1 from "sha1";
const imageExtensions = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".gif",
  ".tiff",
];
/** Fix content-disposition to always be inline for images */
function fixContentDisposition(url: URL, contentDisposition: string | null | undefined) {
  if (!contentDisposition) {
    return "inline"
  }
  if (
    contentDisposition.includes("attachment") &&
    imageExtensions.some((ext) => url.pathname.includes(ext))
  ) {
    // Make sure it's not set to 'attachment' for images.
    // Doing this at read time in case we mess it up - don't want to store bad headers.
    contentDisposition = contentDisposition.replaceAll("attachment", "inline");
  }
  return contentDisposition;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const cache = caches.default;

    // Serve a favicon
    if (url.pathname === "/favicon.ico") {
      // check cache first
      let cacheResponse = await cache.match(request);
      if (cacheResponse) {
        return cacheResponse;
      }
      const r2Res = await env.STATIC_CACHE.get("favicon.jpg");
      if (r2Res) {
        const res = new Response(r2Res.body, {
          headers: {
            "content-type": "image/jpeg",
            "content-disposition": "inline",
            "content-length": r2Res.size.toString(),
            "cache-control": "public, max-age=31536000", // 1 year
          },
        });
        // save to cache
        ctx.waitUntil(cache.put(request, res.clone()));
        return res;
      } else {
        return new Response("Not found", { status: 404 });
      }
    }

    // Now serve the regular stuff
    const keys = {
      read: [env.API_KEY, env.WRITE_API_KEY],
      write: [env.WRITE_API_KEY],
    };

    if (
      !url.searchParams.has("key") ||
      !keys.read.includes(url.searchParams.get("key") || "")
    ) {
      return new Response("Invalid API key", { status: 403 });
    }
    // Check standard cache first
    const match = await cache.match(request);
    if (match) {
      return match;
    }
    // Check R2 cache
    let urlToCacheString = url.searchParams.get("url");
    if (!urlToCacheString) {
      return new Response("Missing url parameter", { status: 400 });
    }
    // Params get screwed up with decoding, so we pass them separately as base64
    const params = url.searchParams.get('params')
    if (params) {
      let decodedParams = atob(decodeURIComponent(params))
      // We should be consistent with use of ? in the encoded params,
      // but just in case, we'll add it if it's missing
      if (!decodedParams.startsWith('?')) {
        decodedParams = '?' + decodedParams
      }
      urlToCacheString += decodedParams
    }
    const urlToCache = new URL(urlToCacheString)
    const urlSha1 = sha1(urlToCacheString);

    console.log("urlSha1: ", urlSha1);
    let cachedResponse: R2ObjectBody | null;
    try {
      cachedResponse = await env.STATIC_CACHE.get(
        CACHE_KEY(urlToCacheString, urlSha1)
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
        "public, max-age=604800, immutable"
        // Removing the below line because I have no need for custom cache-control headers per object
        // cachedResponse.httpMetadata.cacheControl || "public, max-age=604800, immutable" // 1 week
      );
      headers.set("CDN-Cache-Control", "public, max-age=604800, immutable");
      headers.set(
        "Content-Disposition",
        fixContentDisposition(
          url,
          cachedResponse.httpMetadata.contentDisposition
        )
      );
      if (cachedResponse.httpMetadata.contentEncoding) {
        headers.set(
          "Content-Encoding",
          cachedResponse.httpMetadata.contentEncoding
        );
      }
      headers.set("X-R2-Cache-Hit", "true");
      headers.set("Content-Length", cachedResponse.size.toString());
      const response = new Response(cachedResponse.body, {
        status: 200,
        headers: headers,
      });
      // Add R2 response to cache.
      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    } else {
      if (!keys.write.includes(url.searchParams.get("key") || "")) {
        // Tell clients it's not found if they don't have write access
        return new Response("not found", { status: 404 });
      }
      const response = await fetch(urlToCacheString);

      const meta: R2HTTPMetadata = {
        cacheControl: "public, max-age=604800, immutable", // 1 week
        contentType: response.headers.get("Content-Type") || "text/plain",
        contentDisposition:
          response.headers.get("Content-Disposition") || undefined,
        contentEncoding: response.headers.get("Content-Encoding") || undefined,
        contentLanguage: response.headers.get("Content-Language") || undefined,
      };
      if (response.ok) {
        let body: ReadableStream | ArrayBuffer | null
        // Parse the url to get the host
        // List of hosts that we need to read the whole body before sending to R2
        // because they don't send the content-length header
        if (['icons.duckduckgo.com', 'www.google.com'].includes(urlToCache.hostname)) {
          // DuckDuckGo icons don't give a content-length header, so we need to read the whole body
          // into memory to get the size.
          body = await response.clone().arrayBuffer();
        } else {
          body = response.clone().body;
        }
        const cachePromise = env.STATIC_CACHE.put(
          CACHE_KEY(urlToCacheString, urlSha1),
          body,
          {
            httpMetadata: meta,
            customMetadata: {
              url: urlToCacheString,
              url_sha1: urlSha1,
              pathname: url.pathname, // Eg. /dsp/Mining_Machine - for organization only
            },
          }
        );
        ctx.waitUntil(cachePromise);
      }
      const fixedResponse = new Response(response.body, response);
      fixedResponse.headers.set(
        "Content-Disposition",
        fixContentDisposition(
          url,
          response.headers.get("Content-Disposition")
        )
      );
      return fixedResponse;
    }
  },
};

/** Used adds a prefix to r2 cache keys */

function CACHE_KEY(url: string, hash: string) {
  // Remove the scheme to make r2 keys easier to work with in rclone
  const urlWithoutScheme = url.replace(/^https?:\/\//, "");
  // 1024 is the max length of a key in the S3 spec
  return (
    `cache/${urlWithoutScheme}`.slice(0, 1024 - hash.length - 7) +
    "--sha1=" +
    hash
  );
}
