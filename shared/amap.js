const ALLOWED_ORIGINS = new Set([
  'https://lzq1206.github.io',
  'https://subwaywhisper.pages.dev',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

export function isOriginAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  const requestUrl = new URL(request.url);
  return origin === requestUrl.origin && requestUrl.hostname.endsWith('.pages.dev');
}

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const requestUrl = new URL(request.url);
  const allowedOrigin = origin && (ALLOWED_ORIGINS.has(origin) || (origin === requestUrl.origin && requestUrl.hostname.endsWith('.pages.dev')))
    ? origin
    : '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
  return headers;
}

export function jsonResponse(request, body, status = 200) {
  const headers = corsHeaders(request);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(body), { status, headers });
}

export function optionsResponse(request) {
  if (!isOriginAllowed(request)) return jsonResponse(request, { error: true, message: '请求来源不允许' }, 403);
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function errorResponse(request, error) {
  const status = Number(error && error.status) || 502;
  const message = error && error.publicMessage ? error.publicMessage : '高德路线服务暂时不可用';
  return jsonResponse(request, { error: true, message }, status);
}

export function apiError(message, status = 502, publicMessage = message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

export async function requireKey(env) {
  const key = String(env.AMAP_WEB_KEY || '').trim();
  if (!key) throw apiError('Missing AMap Web Service key', 503, 'Cloudflare Worker 尚未配置 AMAP_WEB_KEY 加密 Secret');
  return key;
}

export async function amapGet(path, params, key) {
  const url = new URL('https://restapi.amap.com' + path);
  for (const [name, value] of Object.entries({ ...params, key, output: 'JSON' })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  let response;
  try {
    response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  } catch {
    throw apiError('AMap network request failed');
  }
  if (!response.ok) throw apiError('AMap HTTP ' + response.status);
  let data;
  try {
    data = await response.json();
  } catch {
    throw apiError('AMap returned invalid JSON');
  }
  const code = String(data.infocode || '');
  if (data.status === '0' || (code && code !== '10000')) {
    if (code === '31006' || code === '30007') return null;
    const message = code === '10012'
      ? '高德 Key 暂无此接口权限（10012）'
      : '高德接口返回错误（' + (code || 'unknown') + '）';
    throw apiError('AMap API error ' + code, 502, message);
  }
  return data;
}

export async function rateLimit(context, scope, limit, periodSeconds) {
  const request = context.request;
  const address = request.headers.get('CF-Connecting-IP') || 'unknown-client';
  const bucketUrl = 'https://subwaywhisper-rate-limit.invalid/' + encodeURIComponent(scope + ':' + address);
  const bucketRequest = new Request(bucketUrl);
  try {
    const cache = caches.default;
    const cached = await cache.match(bucketRequest);
    const count = cached ? Number(await cached.text()) || 0 : 0;
    if (count >= limit) return false;
    await cache.put(bucketRequest, new Response(String(count + 1), {
      headers: { 'Cache-Control': 'public, max-age=' + periodSeconds },
    }));
  } catch {
    // The hard per-request AMap call cap below remains active if edge caching is unavailable.
  }
  return true;
}

export function outsideChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  value += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  value += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return value;
}

function transformLng(x, y) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  value += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  value += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return value;
}

export function wgs84ToGcj02(lng, lat) {
  if (outsideChina(lng, lat)) return [lng, lat];
  const a = 6378245;
  const ee = 0.006693421622965943;
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = dLat * 180 / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = dLng * 180 / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}
