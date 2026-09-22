import { amapGet, errorResponse, isOriginAllowed, jsonResponse, optionsResponse, rateLimit, requireKey } from '../../shared/amap.js';

export async function onRequestOptions({ request }) {
  return optionsResponse(request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isOriginAllowed(request)) return jsonResponse(request, { error: true, message: '请求来源不允许' }, 403);
  if (!(await rateLimit(context, 'search', 30, 60))) {
    return jsonResponse(request, { error: true, message: '搜索太频繁，请稍后再试' }, 429);
  }

  const keywords = new URL(request.url).searchParams.get('keywords')?.trim() || '';
  if (keywords.length < 2 || keywords.length > 80) {
    return jsonResponse(request, { error: true, message: '请输入 2–80 个字符的地点关键词' }, 400);
  }

  try {
    const key = await requireKey(env);
    const data = await amapGet('/v3/place/text', {
      keywords,
      offset: 8,
      page: 1,
      extensions: 'base',
    }, key);
    const places = (data?.pois || []).filter((poi) => poi.location).slice(0, 8).map((poi) => ({
      id: String(poi.id || ''),
      name: String(poi.name || ''),
      address: String(poi.address || ''),
      city: [poi.pname, poi.cityname, poi.adname].filter((part) => typeof part === 'string' && part).join(' '),
      location: String(poi.location),
    }));
    return jsonResponse(request, { places });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return optionsResponse(context.request);
  if (context.request.method === 'GET') return onRequestGet(context);
  return jsonResponse(context.request, { error: true, message: '请求方式不支持' }, 405);
}
