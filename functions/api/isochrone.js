import {
  amapGet,
  apiError,
  errorResponse,
  isOriginAllowed,
  jsonResponse,
  optionsResponse,
  outsideChina,
  rateLimit,
  requireKey,
  wgs84ToGcj02,
} from '../../shared/amap.js';

const MAX_ROUTE_QUERIES = 40;
const ROUTE_BATCH_SIZE = 4;
const GRID_SCALE_METERS_PER_MINUTE = {
  transit: 100,
  bike: 90,
  car: 160,
};

function finiteCoordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function gridPoint(origin, row, column, cellMeters) {
  const latitude = origin.lat + row * cellMeters / 111320;
  const metersPerDegreeLongitude = Math.max(10000, 111320 * Math.cos(origin.lat * Math.PI / 180));
  const longitude = origin.lng + column * cellMeters / metersPerDegreeLongitude;
  return { lat: latitude, lng: longitude };
}

function neighbors(row, column) {
  const points = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
      if (rowOffset === 0 && columnOffset === 0) continue;
      points.push([row + rowOffset, column + columnOffset]);
    }
  }
  return points;
}

function getRouteDetails(data, mode) {
  if (!data) return null;
  const route = data.route || {};
  const choices = mode === 'transit' ? (route.transits || []) : (route.paths || []);
  const candidates = choices.map((choice) => {
    const seconds = Number(choice.cost?.duration);
    const distance = Number(choice.distance);
    return {
      durationSeconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
      distanceMeters: Number.isFinite(distance) && distance >= 0 ? distance : 0,
    };
  }).filter((choice) => choice.durationSeconds !== null);
  candidates.sort((left, right) => left.durationSeconds - right.durationSeconds);
  return candidates[0] || null;
}

async function cityCodeForOrigin(origin, key) {
  const [lng, lat] = wgs84ToGcj02(origin.lng, origin.lat);
  const data = await amapGet('/v3/geocode/regeo', {
    location: lng.toFixed(6) + ',' + lat.toFixed(6),
    extensions: 'base',
  }, key);
  const rawCode = data?.regeocode?.addressComponent?.citycode;
  const cityCode = Array.isArray(rawCode) ? rawCode[0] : rawCode;
  if (!cityCode) throw apiError('AMap did not return an origin city code', 422, '无法识别出发点所在城市，请重新选择地图位置');
  return String(cityCode);
}

async function queryRoute(origin, destination, mode, key, cityCode, departure) {
  const [originLng, originLat] = wgs84ToGcj02(origin.lng, origin.lat);
  const [destinationLng, destinationLat] = wgs84ToGcj02(destination.lng, destination.lat);
  const params = {
    origin: originLng.toFixed(6) + ',' + originLat.toFixed(6),
    destination: destinationLng.toFixed(6) + ',' + destinationLat.toFixed(6),
    show_fields: mode === 'car' ? 'cost,tmcs' : 'cost',
  };
  let path;
  if (mode === 'car') {
    path = '/v5/direction/driving';
    params.strategy = 32;
  } else if (mode === 'bike') {
    path = '/v5/direction/bicycling';
  } else {
    path = '/v5/direction/transit/integrated';
    params.city1 = cityCode;
    params.city2 = cityCode;
    params.strategy = 8;
    params.AlternativeRoute = 1;
    params.date = departure.date;
    params.time = departure.time;
  }
  const data = await amapGet(path, params, key);
  return getRouteDetails(data, mode);
}

function validDeparture(value) {
  if (!value || typeof value !== 'object') return false;
  const date = String(value.date || '');
  const time = String(value.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}-\d{2}$/.test(time)) return false;
  const [hour, minute] = time.split('-').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export async function onRequestOptions({ request }) {
  return optionsResponse(request);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!isOriginAllowed(request)) return jsonResponse(request, { error: true, message: '请求来源不允许' }, 403);
  if (!(await rateLimit(context, 'reach', 3, 60))) {
    return jsonResponse(request, { error: true, message: '路线查询太频繁，请稍后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: true, message: '请求内容格式错误' }, 400);
  }

  const origin = {
    lng: finiteCoordinate(body?.origin?.lng, 73, 135.5),
    lat: finiteCoordinate(body?.origin?.lat, 2.5, 54),
  };
  const mode = String(body?.mode || '');
  const maxMinutes = Number(body?.maxMinutes);
  if (origin.lng === null || origin.lat === null || outsideChina(origin.lng, origin.lat)) {
    return jsonResponse(request, { error: true, message: '出发点必须位于中国大陆范围内' }, 400);
  }
  if (!['transit', 'bike', 'car'].includes(mode)) {
    return jsonResponse(request, { error: true, message: '出行方式不支持' }, 400);
  }
  if (![10, 20, 30, 40, 50, 60].includes(maxMinutes)) {
    return jsonResponse(request, { error: true, message: '通勤时间需为 10–60 分钟的 10 分钟整数档' }, 400);
  }
  if (mode === 'transit' && !validDeparture(body.departure)) {
    return jsonResponse(request, { error: true, message: '请选择公交出发日期和时间' }, 400);
  }

  try {
    const key = await requireKey(env);
    const cityCode = mode === 'transit' ? await cityCodeForOrigin(origin, key) : '';
    const cellMeters = Math.max(600, Math.min(6000, Math.round(maxMinutes * GRID_SCALE_METERS_PER_MINUTE[mode] / 100) * 100));
    const originCell = {
      row: 0,
      column: 0,
      lat: origin.lat,
      lng: origin.lng,
      durationSeconds: 0,
      distanceMeters: 0,
    };
    const cells = [originCell];
    const seen = new Set(['0,0']);
    let frontier = neighbors(0, 0);
    for (const [row, column] of frontier) seen.add(row + ',' + column);
    let queryCount = 0;

    while (frontier.length && queryCount < MAX_ROUTE_QUERIES) {
      const batch = frontier.splice(0, Math.min(ROUTE_BATCH_SIZE, MAX_ROUTE_QUERIES - queryCount));
      queryCount += batch.length;
      const results = await Promise.all(batch.map(async ([row, column]) => {
        const point = gridPoint(origin, row, column, cellMeters);
        if (outsideChina(point.lng, point.lat)) {
          return { row, column, point, route: null };
        }
        const route = await queryRoute(origin, point, mode, key, cityCode, body.departure);
        return { row, column, point, route };
      }));

      const nextFrontier = [];
      for (const result of results) {
        const cell = {
          row: result.row,
          column: result.column,
          lat: result.point.lat,
          lng: result.point.lng,
          durationSeconds: result.route?.durationSeconds ?? null,
          distanceMeters: result.route?.distanceMeters ?? 0,
        };
        cells.push(cell);
        if (cell.durationSeconds === null || cell.durationSeconds > maxMinutes * 60) continue;
        for (const [row, column] of neighbors(result.row, result.column)) {
          const id = row + ',' + column;
          if (seen.has(id)) continue;
          seen.add(id);
          nextFrontier.push([row, column]);
        }
      }
      frontier = nextFrontier;
    }

    const reachableCells = cells.filter((cell) => cell.durationSeconds !== null && cell.durationSeconds <= maxMinutes * 60);
    return jsonResponse(request, {
      provider: 'amap',
      mode,
      cityCode: cityCode || undefined,
      maxMinutes,
      cellMeters,
      queryCount,
      sampleLimit: MAX_ROUTE_QUERIES,
      truncated: frontier.length > 0,
      reachableCount: reachableCells.length,
      cells,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return optionsResponse(context.request);
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonResponse(context.request, { error: true, message: '请求方式不支持' }, 405);
}
