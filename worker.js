/**
 * Bangumi Cloudflare Worker：API、图片、主站共用一个 Worker。
 * 配置 API_HOST / IMG_HOST / WEB_HOST，并将三个自定义域名绑定到 Worker。
 * API / 图片保留 PATH_PREFIX；主站使用根路径，兼容页面脚本和表单。
 * 主站访问 https://WEB_HOST/；健康检查为各角色的 /__health。
 */
const API_HOST = "bgmapi.example.com";
const IMG_HOST = "bgmimg.example.com";
const WEB_HOST = "bgm.example.com";
const PATH_PREFIX = "abc123xyz"; // 仅 API 和图片；空字符串禁用

const BGM_API = "api.bgm.tv";
const BGM_API_NEXT = "next.bgm.tv";
const BGM_IMG = "lain.bgm.tv";
const BGM_WEB = "bgm.tv";
const WEB_ALIASES = [BGM_WEB, "bangumi.tv", "chii.in"];
const IMG_CACHE_TTL = 30 * 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 25000;
const PREFIX = PATH_PREFIX ? `/${PATH_PREFIX}` : "";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const role = url.hostname === WEB_HOST ? "web"
      : url.hostname === IMG_HOST ? "img"
      : url.hostname === API_HOST ? "api" : null;
    if (!role) return new Response("Not Found", { status: 404 });

    if (role !== "web" && PREFIX) {
      // 必须匹配完整路径段，不能让 /prefix-other 绕过校验。
      if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
        return new Response("Not Found", { status: 404 });
      }
      url.pathname = url.pathname.slice(PREFIX.length) || "/";
    }
    if (request.method === "OPTIONS" && role !== "web") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const upstream = role === "web" ? BGM_WEB : role === "img" ? BGM_IMG
      : url.pathname === "/p1" || url.pathname.startsWith("/p1/") ? BGM_API_NEXT : BGM_API;
    if (url.pathname === "/__health") {
      return new Response(JSON.stringify({
        ok: true, host: url.hostname, role, upstream,
        apiHost: API_HOST, imgHost: IMG_HOST, webHost: WEB_HOST,
        pathPrefix: role === "web" ? "(disabled)" : PATH_PREFIX || "(disabled)",
      }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    try {
      if (role === "img") return await handleImage(request, url, ctx);
      return await handleProxy(request, url, upstream, role);
    } catch (error) {
      console.error("Bangumi upstream request failed", role, error.name);
      return new Response("Bad Gateway", {
        status: 502,
        headers: { "cache-control": "no-store", ...(role === "web" ? {} : corsHeaders(request)) },
      });
    }
  },
};

async function handleProxy(request, url, upstream, role) {
  const upstreamURL = `https://${upstream}${url.pathname}${url.search}`;
  const requestHeaders = cleanRequestHeaders(request.headers);
  if (role === "web") {
    for (const name of ["origin", "referer"]) {
      const value = requestHeaders.get(name);
      if (value) requestHeaders.set(name, restoreSource(value, name === "origin"));
    }
    // 改写后的表示不应使用源站 ETag/304 或部分响应。
    for (const name of ["if-none-match", "if-modified-since", "range", "if-range"]) {
      requestHeaders.delete(name);
    }
  }
  const resp = await fetch(new Request(upstreamURL, {
    method: request.method, headers: requestHeaders,
    body: hasBody(request.method) ? request.body : undefined,
    redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }));
  const headers = new Headers(resp.headers);
  if (role !== "web") setCors(headers, request);
  rewriteResponseHeaders(headers, resp.headers, upstreamURL, role);

  const ct = (headers.get("content-type") || "").toLowerCase();
  const isText = ct.startsWith("text/") || /(?:json|javascript|ecmascript|xml|svg\+xml)/.test(ct);
  const noBody = request.method === "HEAD" || [101, 204, 205, 304].includes(resp.status);
  let body = noBody ? null : resp.body;
  if (isText && !noBody) {
    body = rewriteText(await resp.text(), role === "web");
    for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest", "accept-ranges"]) {
      headers.delete(name);
    }
  }
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers });
}

// 图片域名始终只访问 lain.bgm.tv；主站封面/头像和 API 图片共享此缓存。
async function handleImage(request, url, ctx) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }
  const upstreamURL = `https://${BGM_IMG}${url.pathname}${url.search}`;
  const cache = caches.default;
  const cacheKey = new Request(upstreamURL);
  const cacheable = request.method === "GET" && !request.headers.has("range")
    && !request.headers.has("authorization") && !request.headers.has("cookie");
  if (cacheable) {
    // Cache API 故障不应阻断源站读取。
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      const out = new Response(hit.body, hit);
      out.headers.set("x-cache", "HIT");
      setCors(out.headers, request);
      return out;
    }
  }
  const resp = await fetch(new Request(upstreamURL, {
    method: request.method, headers: cleanRequestHeaders(request.headers),
    redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }));
  const out = new Response(request.method === "HEAD" ? null : resp.body, resp);
  rewriteResponseHeaders(out.headers, resp.headers, upstreamURL, "img");
  out.headers.set("x-cache", "MISS");
  if (cacheable && resp.status === 200 && !resp.headers.has("set-cookie")
      && !/private|no-store|no-cache/i.test(resp.headers.get("cache-control") || "")) {
    out.headers.set("cache-control", `public, max-age=${IMG_CACHE_TTL}`);
    // 缓存与请求 Origin 无关的表示，避免把上一个访问者的 CORS 响应缓存进去。
    ctx.waitUntil(cache.put(cacheKey, out.clone()).catch(() => {}));
  }
  setCors(out.headers, request);
  return out;
}

function targetFor(host, includeSite) {
  if (host === BGM_IMG) return `${IMG_HOST}${PREFIX}`;
  if (!includeSite) return null;
  if (WEB_ALIASES.includes(host)) return WEB_HOST;
  if (host === BGM_API || host === BGM_API_NEXT) return `${API_HOST}${PREFIX}`;
  return null;
}

function rewriteText(text, includeSite) {
  // 覆盖普通、协议相对地址及 JSON 中的 https:\/\/；完整主机边界避免误改外站。
  return text.replace(/(?:https?:)?(?:\/\/|\\\/\\\/)(lain\.bgm\.tv|api\.bgm\.tv|next\.bgm\.tv|bgm\.tv|bangumi\.tv|chii\.in)(?=[/\\\s"'<>):;,#?]|$)/gi,
    (match, host) => {
      const target = targetFor(host.toLowerCase(), includeSite);
      if (!target) return match;
      return match.includes("\\/") ? `https:\\/\\/${target.replaceAll("/", "\\/")}` : `https://${target}`;
    });
}

function rewriteURL(value, base, includeSite) {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return value;
    const target = targetFor(url.hostname, includeSite);
    if (!target) return value;
    return `https://${target}${url.pathname}${url.search}${url.hash}`;
  } catch { return value; }
}

function rewriteResponseHeaders(headers, original, base, role) {
  const includeSite = role === "web";
  const location = headers.get("location");
  if (location) headers.set("location", rewriteURL(location, base, includeSite));
  for (const name of ["refresh", "link", "content-location"]) {
    const value = headers.get(name);
    if (value) headers.set(name, rewriteText(value, includeSite));
  }
  if (role === "web") {
    // 浏览器仅接受当前代理域的 Cookie；保留 Path、HttpOnly、Secure、SameSite 等属性。
    // 兼容 Workers 旧兼容日期提供的 getAll("Set-Cookie")。
    const cookies = typeof original.getSetCookie === "function"
      ? original.getSetCookie() : original.getAll("Set-Cookie");
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      headers.append("set-cookie", cookie.replace(/;\s*domain\s*=\s*\.?[^;]+/gi, ""));
    }
    for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
      const value = headers.get(name);
      if (value) headers.set(name, rewriteText(value, true));
    }
    // 登录页和用户页面不在代理层共享缓存。
    headers.set("cache-control", "private, no-store");
    headers.delete("cdn-cache-control");
    headers.delete("cloudflare-cdn-cache-control");
    headers.delete("clear-site-data");
  }
}

function restoreSource(value, originOnly = false) {
  try {
    const url = new URL(value);
    if (url.hostname !== WEB_HOST) return value;
    url.protocol = "https:";
    url.host = BGM_WEB;
    return originOnly ? url.origin : url.href;
  } catch { return value; }
}

function cleanRequestHeaders(input) {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) {
    if (name === "host" || name.startsWith("cf-") || name.startsWith("x-forwarded-")
        || ["forwarded", "connection", "keep-alive", "transfer-encoding"].includes(name)) headers.delete(name);
  }
  return headers;
}
function hasBody(method) { return !["GET", "HEAD"].includes(method.toUpperCase()); }
function corsHeaders(request) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (request.headers.get("origin") === `https://${WEB_HOST}`) {
    headers["Access-Control-Allow-Origin"] = `https://${WEB_HOST}`;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}
function setCors(headers, request) {
  headers.delete("access-control-allow-credentials");
  for (const [name, value] of Object.entries(corsHeaders(request))) headers.set(name, value);
  const vary = headers.get("vary");
  if (!vary?.split(",").some(value => value.trim().toLowerCase() === "origin")) {
    headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  }
}
