import { errorResponse, isOriginAllowed, jsonResponse, optionsResponse } from '../../shared/amap.js';

export function onRequestOptions({ request }) {
  return optionsResponse(request);
}

export function onRequestGet(context) {
  if (!isOriginAllowed(context.request)) return jsonResponse(context.request, { error: true, message: '请求来源不允许' }, 403);
  return jsonResponse(context.request, {
    ready: Boolean(String(context.env.AMAP_WEB_KEY || '').trim()),
    provider: 'amap',
  });
}

export function onRequest(context) {
  if (context.request.method === 'OPTIONS') return optionsResponse(context.request);
  if (context.request.method === 'GET') return onRequestGet(context);
  return errorResponse(context.request, Object.assign(new Error('Method not allowed'), { status: 405, publicMessage: '请求方式不支持' }));
}
