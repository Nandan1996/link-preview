/**
 * Cloudflare Workers implementation of link-preview API service.
 *
 * Workers doc: https://developers.cloudflare.com/workers/
 */

import { version } from "../package.json";
import { HTMLElement, parse } from "node-html-parser";

export interface Env {}

function dbg(...message: any[]) {
  console.info("[✌ link-preview] ", ...message);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const reqUrl = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      // Handle (accept) preflight requests from web browsers
      return handleOptions(request, origin);
    } else if (request.method === "GET") {
      const query = reqUrl.searchParams.get("q");
      if (query) {
        // Primary feature: Return website's metadata for preview
        try {
          const md = await extractMetadata(query);
          return new Response(JSON.stringify(md), {
            headers: withMonthLongCache(
              withCorsHeaders(origin, {
                "content-type": "application/json",
              })
            ),
          });
        } catch (e) {
          return handleError(422, `[Failed to preview] ${e}`, origin);
        }
      } else {
        const twitterUserName = reqUrl.searchParams.get("tw-profile-icon");
        if (twitterUserName) {
          // Hidden feature: Directly return Twitter profile image (and cache)
          return handleGetTwitterProfileImage(twitterUserName, origin);
        } else {
          return handleError(400, "Bad Request", origin);
        }
      }
    } else {
      return handleError(400, "Bad Request", origin);
    }
  },
};

// From: https://stackoverflow.com/a/69685872
function handleOptions(request: Request, origin: string) {
  let headers = request.headers;
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null &&
    headers.get("Access-Control-Request-Headers") !== null
  ) {
    return new Response(null, {
      headers: withCorsHeaders(origin, {
        "Access-Control-Max-Age": "86400",
        "Access-Control-Allow-Headers":
          request.headers.get("Access-Control-Request-Headers") || "",
      }),
    });
  } else {
    return new Response(null, {
      headers: { Allow: "GET" },
    });
  }
}

const subrequestCacheBehavior = {
  cacheTtlByStatus: { "200-499": 60 * 60 * 24 * 7, "500-599": 0 },
  cacheEverything: true,
};

async function handleGetTwitterProfileImage(
  twitterUserName: string,
  origin: string
): Promise<Response> {
  const url = `https://twitter.com/${twitterUserName}`;
  const md = await extractMetadata(url);
  // Profile page has profile image URL as metadata
  if (md.image) {
    const res = await fetch(md.image, {
      cf: { ...subrequestCacheBehavior, cacheKey: twitterUserName },
    });
    logSubrequest(res);
    const contentType = res.headers.get("content-type") || "text/plain";
    if (contentType.startsWith("image/")) {
      // Hide origin info, creating new Response object.
      return new Response(res.body, {
        status: res.status,
        headers: withMonthLongCache(
          withCorsHeaders(origin, { "content-type": contentType })
        ),
      });
    } else {
      return handleError(
        422,
        `${url} does not have user profile image!`,
        origin
      );
    }
  } else {
    return handleError(404, "Not Found", origin);
  }
}

type Metadata = {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  image?: string | null;
  icon?: string | null; // Added this line
  charset?: string | null;
  error?: string | null;
  siteName?: string;
};

function logSubrequest(res: Response) {
  dbg(`Subrequest: ${res.url} ${res.status}`);
  let loggedHeaders = "";
  for (const [k, v] of res.headers.entries()) {
    loggedHeaders += `\t${k}: ${v}\n`;
  }
  dbg(`Subrequest headers:\n${loggedHeaders}`);
}

async function extractMetadata(query: string): Promise<Metadata> {
  const headers = {
    accept: "text/html,application/xhtml+xml",
    // When declared as Bot, some sites generously return prerendered metadata for preview (e.g. Twitter)
    //"user-agent": `LinkPreviewBot/${version}`,
    "user-agent": `WhatsApp/${version}`,
    "accept-language": "en-US,en;q=0.9",
  };
  const res = await fetch(query, {
    redirect: "follow",
    headers: headers,
    cf: { ...subrequestCacheBehavior, cacheKey: query },
  });
  logSubrequest(res);
  if (res.status >= 400) {
    return { error: `[Error] ${query} returned status code: ${res.status}!` };
  }

  const rawBody = await res.arrayBuffer();
  const utf8Body = new TextDecoder("utf-8").decode(rawBody);
  const parsedUtf8Body = parse(utf8Body);
  const detectedCharset = detectCharset(res.headers, parsedUtf8Body);
  dbg("Detected charset", detectedCharset);
  const parsed =
    detectedCharset === "utf-8"
      ? parsedUtf8Body
      : parse(new TextDecoder(detectedCharset).decode(rawBody));
  const $ = (q: string) => parsed.querySelector(q);

  const title =
    $('meta[property="og:title"]')?.getAttribute("content") ||
    $('meta[property="twitter:title"]')?.getAttribute("content") ||
    $("title")?.textContent;

  const description =
    $('meta[property="og:description"]')?.getAttribute("content") ||
    $('meta[property="twitter:description"]')?.getAttribute("content") ||
    $('meta[name="description"]')?.getAttribute("content");

  const resolveRelativeUrl = (url: string, baseHref: string = query) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    } else {
      return new URL(url, baseHref).href;
    }
  }

  let url = query;
  const canonicalUrl =
    $('link[rel="canonical"]')?.getAttribute("href") ||
    $('meta[property="og:url"]')?.getAttribute("content");
  if (canonicalUrl) {
    url = resolveRelativeUrl(canonicalUrl);
  }

  const baseHref = canonicalUrl || query;

  let image;
  const ogpImage =
    $('meta[property="og:image"]')?.getAttribute("content") ||
    $('meta[property="twitter:image"]')?.getAttribute("content");
  if (ogpImage) {
    image = resolveRelativeUrl(ogpImage, baseHref);
  }

  // Extract favicon
  let icon: string | null = null;
  const faviconLink = parsed.querySelector('link[rel="icon"]') || parsed.querySelector('link[rel="shortcut icon"]');
  if (faviconLink) {
    const faviconHref = faviconLink.getAttribute("href");
    if (faviconHref) {
      icon = resolveRelativeUrl(faviconHref, baseHref);
    }
  }
  const siteName = $('meta[property="og:site_name"]')?.getAttribute("content");

  return { title, description, url, image, icon, charset: detectedCharset, siteName };
}

function detectCharset(
  headers: Headers,
  parsed: HTMLElement
): "utf-8" | "shift_jis" | string {
  const headerContentType = headers.get("content-type");
  const headerCharset = headerContentType?.includes("charset=")
    ? headerContentType
        .split("charset=")[1]
        .toLowerCase()
        .replace(/^["']/, "")
        .replace(/["']$/, "")
    : undefined;

  let bodyCharset = parsed
    .querySelector("meta[charset]")
    ?.getAttribute("charset")
    ?.toLowerCase()
    .replace(/^["']/, "")
    .replace(/["']$/, "");
  if (!bodyCharset) {
    const bodyContentType = parsed
      .querySelector('meta[http-equiv="Content-Type" i]')
      ?.getAttribute("content");
    if (bodyContentType?.includes("charset=")) {
      bodyCharset = bodyContentType
        .split("charset=")[1]
        .toLowerCase()
        .replace(/^["']/, "")
        .replace(/["']$/, "");
    }
  }

  // TODO: headerCharsetとbodyCharsetが食い違った場合、headerCharsetを優先しているが、
  // bodyCharsetを優先したほうが打率が高そうであれば変更するかも
  dbg("headerCharset", headerCharset);
  dbg("bodyCharset", bodyCharset);
  return headerCharset || bodyCharset || "utf-8";
}

function help(host: string): string {
  return `
Hi! This is a link-preview service on Cloudflare Workers.

If you are seeing this message, at least you connected to our endpoint successfully.

Correct usage is:

    GET ${host}?q=https://cloudflare.com

This should return JSON payload like this:

    {
      "title": "Cloudflare - The Web Performance & Security Company",
      "description": "Here at Cloudflare, we make the Internet work the way it should. Offering CDN, DNS, DDoS protection and security, find out how we can help your site.",
      "url": "https://www.cloudflare.com/",
      "image": "https://www.cloudflare.com/static/b30a57477bde900ba55c0b5f98c4e524/Cloudflare_default_OG_.png"
    }

In short, supply whatever public URL as a query parameter "q", then send GET request. That's all!
If the URL contains non-ASCII characters, url-encode them.

Source code: https://github.com/ymtszw/link-preview

This service is EXTREMELY easy to self-host; i.e. deploy on your own Cloudflare account.
If you are going to throw many link-preview requests here, do consider it!
`;
}

function withCorsHeaders(
  origin: string,
  otherHeaders: HeadersInit
): HeadersInit {
  return {
    ...otherHeaders,
    Vary: "Origin",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET",
  };
}

function withMonthLongCache(otherHeaders: HeadersInit): HeadersInit {
  return {
    ...otherHeaders,
    "Cache-Control":
      "public, stale-if-error=60, stale-while-revalidate=60, max-age=" +
      30 * 24 * 60 * 60,
    "CDN-Cache-Control":
      "public, stale-if-error=60, stale-while-revalidate=60, max-age=" +
      7 * 24 * 60 * 60,
  };
}

function handleError(
  status: number,
  message: string,
  origin: string
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      message: help(origin),
    }),
    {
      status: status,
      headers: withCorsHeaders(origin, {
        "content-type": "application/json",
        "Cache-Control": "public, max-age=" + 60 * 60,
        "CDN-Cache-Control": "public, max-age=" + 10 * 60,
      }),
    }
  );
}
