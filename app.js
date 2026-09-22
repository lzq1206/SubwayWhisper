'use strict';

const AMAP_WEB_KEY = '9ec9628db5e66650e43dea74f85a8262';
const AMAP_BASE = 'https://restapi.amap.com';
const AMAP_REQUEST_INTERVAL_MS = 1200;
const VALHALLA_ISOCHRONE_URL = 'https://valhalla1.openstreetmap.de/isochrone';
const VALHALLA_CLIENT_ID = 'https://lzq1206.github.io/SubwayWhisper/';
const BLUE = '#2864e8';
const BLUE_HEX = '2864e8';
const LAYER_OPACITIES = [0.31, 0.24, 0.18, 0.13, 0.09, 0.055];
const TRANSIT_MAX_MINUTES = 45;
const ROAD_MAX_MINUTES = 60;
const TRANSIT_QUERY_GAP_MS = 350;
const MODES = {
  transit: { name: '公交 / 地铁', source: '高德公交到达圈' },
  bike: { name: '骑行', source: 'OSM 路网等时圈' },
  car: { name: '驾车', source: 'OSM 路网等时圈' },
};

let amapRequestQueue = Promise.resolve();
let lastAmapRequestStartedAt = 0;
let map = null;
let arrivalRange = null;
let origin = null;
let originName = '';
let originMarker = null;
let reachOverlays = [];
let activeMode = 'transit';
let toastTimeout = 0;
let activeController = null;

const elements = {
  searchForm: document.querySelector('#search-form'),
  searchInput: document.querySelector('#place-search'),
  searchResults: document.querySelector('#search-results'),
  locateButton: document.querySelector('#locate-button'),
  timeRange: document.querySelector('#time-range'),
  timeValue: document.querySelector('#time-value'),
  modeHint: document.querySelector('#mode-hint'),
  calculateButton: document.querySelector('#calculate-button'),
  modeButtons: [...document.querySelectorAll('.mode-card')],
  resultTitle: document.querySelector('#result-title'),
  areaValue: document.querySelector('#area-value'),
  radiusValue: document.querySelector('#radius-value'),
  legend: document.querySelector('#legend'),
  legendTitle: document.querySelector('#legend-title'),
  legendItems: document.querySelector('#legend-items'),
  mapStatus: document.querySelector('#map-status'),
  toast: document.querySelector('#toast'),
  zoomIn: document.querySelector('#zoom-in'),
  zoomOut: document.querySelector('#zoom-out'),
};

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);
}

function showToast(message, duration = 4200) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => { elements.toast.hidden = true; }, duration);
}

function setMapStatus(message) {
  elements.mapStatus.textContent = message;
}

function initializeMap() {
  if (!window.AMap) {
    setMapStatus('高德地图未加载 · 请检查 JS API Key');
    elements.calculateButton.disabled = true;
    showToast('高德地图 API 未能加载，请检查 JS API Key 和安全密钥设置', 7000);
    return;
  }

  map = new AMap.Map('map', {
    zoom: 12,
    center: wgs84ToGcj02(121.4737, 31.2304),
    mapStyle: 'amap://styles/normal',
    features: ['bg', 'point', 'road', 'building'],
    viewMode: '2D',
    resizeEnable: true,
    showIndoorMap: false,
  });
  if (AMap.Scale) map.addControl(new AMap.Scale());

  map.on('click', (event) => {
    const point = [Number(event.lnglat.getLng()), Number(event.lnglat.getLat())];
    const [lng, lat] = gcj02ToWgs84(point[0], point[1]);
    placeOrigin({ lat, lng });
    elements.searchInput.value = lat.toFixed(4) + ', ' + lng.toFixed(4);
    showToast('出发点已更新');
  });
  setMapStatus('高德地图就绪 · 搜索地点或点击地图开始');
}

function currentLimit() {
  return activeMode === 'transit' ? TRANSIT_MAX_MINUTES : ROAD_MAX_MINUTES;
}

function updateTimeControl() {
  const max = currentLimit();
  elements.timeRange.max = String(max);
  elements.timeRange.step = activeMode === 'transit' ? '5' : '10';
  if (Number(elements.timeRange.value) > max) elements.timeRange.value = String(max);

  const ticks = activeMode === 'transit' ? [10, 20, 30, 40, 45] : [10, 20, 30, 40, 50, 60];
  const tickContainer = document.querySelector('.range-ticks');
  tickContainer.replaceChildren();
  for (const tick of ticks) {
    const label = document.createElement('span');
    label.textContent = tick === max ? tick + ' 分钟' : String(tick);
    tickContainer.append(label);
  }
  updateTimeLabel();
}

function updateRangeTrack() {
  const min = Number(elements.timeRange.min);
  const max = Number(elements.timeRange.max);
  const value = Number(elements.timeRange.value);
  const percent = ((value - min) / (max - min)) * 100;
  elements.timeRange.style.setProperty('--range-progress', percent + '%');
}

function updateTimeLabel() {
  const maxMinutes = Number(elements.timeRange.value);
  elements.timeValue.innerHTML = maxMinutes + ' <span>分钟</span>';
  updateRangeTrack();
}

function setModeHint() {
  elements.modeHint.textContent = activeMode === 'transit'
    ? '公交范围来自高德官方到达圈，按所选分钟数查询，不指定出发时刻；当前最多 45 分钟。'
    : '范围根据 OpenStreetMap 路网计算；通行速度来自路网模型，不含实时路况。';
}

function amapErrorMessage(code, info) {
  const messages = {
    '10001': '高德 Web 服务 Key 无效或已过期',
    '10002': '当前 Key 没有该 Web 服务接口权限',
    '10003': '高德接口今日调用量已达上限',
    '10004': '高德接口请求过于频繁，请稍后再试',
    '10009': '该 Key 平台类型与 Web 服务不匹配',
    '10021': '高德账号接口 QPS 已超限，请稍后再试',
  };
  return messages[String(code)] || ('高德接口错误（' + (code || '未知') + '）' + (info ? '：' + info : ''));
}

function waitForRequestSlot(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const delay = Math.max(0, lastAmapRequestStartedAt + AMAP_REQUEST_INTERVAL_MS - Date.now());
    if (!delay) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    function onAbort() {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function amapGet(path, params, signal) {
  const task = amapRequestQueue.then(async () => {
    await waitForRequestSlot(signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    lastAmapRequestStartedAt = Date.now();
    const url = new URL(path, AMAP_BASE);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    url.searchParams.set('key', AMAP_WEB_KEY);
    url.searchParams.set('output', 'JSON');
    const response = await fetch(url, { signal });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.status !== '1' || data.infocode !== '10000') {
      throw new Error(amapErrorMessage(data.infocode, data.info));
    }
    return data;
  });
  amapRequestQueue = task.catch(() => {});
  return task;
}

function clearResults(message = '设置出发点后计算可达边界') {
  if (activeController) activeController.abort();
  activeController = null;
  if (map && reachOverlays.length) map.remove(reachOverlays);
  reachOverlays = [];
  elements.areaValue.textContent = '—';
  elements.radiusValue.textContent = '—';
  elements.legend.hidden = true;
  elements.calculateButton.disabled = !origin || !map;
  elements.calculateButton.textContent = '计算可达边界';
  elements.resultTitle.textContent = origin ? '等待计算可达等时圈' : '等待选择出发点';
  setMapStatus(message);
}

function toAmapCoordinate(point) {
  return wgs84ToGcj02(Number(point.lng), Number(point.lat));
}

function placeOrigin(point, name = '') {
  origin = { lat: Number(point.lat), lng: Number(point.lng) };
  originName = name.trim() || origin.lat.toFixed(4) + ', ' + origin.lng.toFixed(4);
  if (!map) return;
  if (originMarker) map.remove(originMarker);

  const coordinate = toAmapCoordinate(origin);
  originMarker = new AMap.Marker({
    position: coordinate,
    title: originName || '出发点',
    content: '<span class="origin-marker" aria-hidden="true"></span>',
    offset: new AMap.Pixel(-12, -24),
    zIndex: 2000,
  });
  map.add(originMarker);
  if (name) elements.searchInput.value = name;
  elements.calculateButton.disabled = false;
  clearResults('出发点已设置 · 点击地图可更换');
}

function getContourTimes(maxMinutes) {
  const times = [];
  for (let minutes = 10; minutes < maxMinutes; minutes += 10) times.push(minutes);
  if (!times.includes(maxMinutes)) times.push(maxMinutes);
  return times;
}

function opacityForTime(minutes) {
  const tier = Math.max(1, Math.ceil(minutes / 10));
  return LAYER_OPACITIES[Math.min(tier - 1, LAYER_OPACITIES.length - 1)];
}

function addLegend(maxMinutes) {
  const thresholds = getContourTimes(maxMinutes);
  elements.legendItems.replaceChildren();
  for (let index = 0; index < thresholds.length; index += 1) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = 'rgba(40, 100, 232, ' + opacityForTime(thresholds[index]) + ')';
    const label = document.createElement('span');
    const start = index * 10;
    label.textContent = start + '–' + thresholds[index] + ' 分钟';
    item.append(swatch, label);
    elements.legendItems.append(item);
  }
  elements.legendTitle.innerHTML = '<span class="legend-pin" aria-hidden="true">●</span> ' + MODES[activeMode].source;
  elements.legend.hidden = false;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeAmapPoint(point) {
  if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
  if (point && typeof point.getLng === 'function' && typeof point.getLat === 'function') {
    return [Number(point.getLng()), Number(point.getLat())];
  }
  if (point && Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat))) {
    return [Number(point.lng), Number(point.lat)];
  }
  return null;
}

function queryArrivalRange(center, minutes, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    if (!arrivalRange) {
      if (!AMap.ArrivalRange) {
        reject(new Error('高德公交到达圈插件未加载，请检查 JS API Key 配置'));
        return;
      }
      arrivalRange = new AMap.ArrivalRange();
    }
    let settled = false;
    function onAbort() {
      if (settled) return;
      settled = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    arrivalRange.search(center, minutes, (status, result) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (status !== 'complete' || !Array.isArray(result?.bounds) || !result.bounds.length) {
        reject(new Error(result?.info || '高德没有返回公交可达边界，请换一个出发点或缩短时间'));
        return;
      }
      const shapes = result.bounds.map((path) => {
        const ring = Array.isArray(path) ? path.map(normalizeAmapPoint).filter(Boolean) : [];
        return { minutes, polygons: ring.length >= 3 ? [[ring]] : [] };
      }).filter((shape) => shape.polygons.length);
      if (!shapes.length) {
        reject(new Error('高德返回了无法识别的公交边界，请稍后重试'));
        return;
      }
      resolve(shapes);
    }, { policy: 'BUS,SUBWAY', resultType: 'polygon' });
  });
}

async function buildTransitReach(maxMinutes, signal) {
  const thresholds = getContourTimes(maxMinutes);
  const center = toAmapCoordinate(origin);
  const shapes = [];
  for (let index = 0; index < thresholds.length; index += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const minutes = thresholds[index];
    setMapStatus('正在查询高德公交到达圈 · ' + minutes + ' 分钟 · ' + (index + 1) + '/' + thresholds.length);
    const tierShapes = await queryArrivalRange(center, minutes, signal);
    shapes.push(...tierShapes);
    if (index < thresholds.length - 1) await delay(TRANSIT_QUERY_GAP_MS, signal);
  }
  return { shapes, queryCount: thresholds.length };
}

async function buildRoadReach(maxMinutes, signal) {
  const thresholds = getContourTimes(maxMinutes);
  const batches = [];
  for (let index = 0; index < thresholds.length; index += 4) batches.push(thresholds.slice(index, index + 4));
  const features = [];
  const costing = activeMode === 'car' ? 'auto' : 'bicycle';

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    setMapStatus('正在计算 OSM 路网等时圈 · ' + (batchIndex + 1) + '/' + batches.length);
    const body = {
      locations: [{ lat: origin.lat, lon: origin.lng }],
      costing,
      contours: batches[batchIndex].map((time) => ({ time, color: BLUE_HEX })),
      polygons: true,
      denoise: 0,
      generalize: 25,
      show_locations: false,
    };
    const url = VALHALLA_ISOCHRONE_URL + '?json=' + encodeURIComponent(JSON.stringify(body));
    const response = await fetch(url, {
      signal,
      headers: { 'X-Client-Id': VALHALLA_CLIENT_ID },
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.error || !Array.isArray(data.features)) {
      throw new Error(data.error || data.error_description || 'OpenStreetMap 路网服务暂不可用，请稍后重试');
    }
    features.push(...data.features);
  }

  const shapes = features.map((feature) => {
    const minutes = Number(feature.properties?.contour ?? feature.properties?.time);
    const geometry = feature.geometry;
    if (!Number.isFinite(minutes) || !geometry) return null;
    let polygons = [];
    if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
    const converted = polygons.map((rings) => rings.map((ring) => ring
      .map((coordinate) => wgs84ToGcj02(Number(coordinate[0]), Number(coordinate[1])))
      .filter((coordinate) => coordinate.every(Number.isFinite))))
      .filter((rings) => rings.length && rings[0].length >= 3);
    return converted.length ? { minutes, polygons: converted } : null;
  }).filter(Boolean);

  if (!shapes.length) throw new Error('OSM 路网没有返回可显示的等时圈，请换一个出发点或缩短时间');
  return { shapes, queryCount: batches.length };
}

function sphericalRingAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const earthRadiusMeters = 6371008.8;
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const currentLat = current[1] * Math.PI / 180;
    const nextLat = next[1] * Math.PI / 180;
    const deltaLng = (next[0] - current[0]) * Math.PI / 180;
    total += deltaLng * (2 + Math.sin(currentLat) + Math.sin(nextLat));
  }
  return Math.abs(total * earthRadiusMeters * earthRadiusMeters / 2) / 1_000_000;
}

function haversineMeters(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(first[1]);
  const lat2 = radians(second[1]);
  const dLat = lat2 - lat1;
  const dLng = radians(second[0] - first[0]);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonMetrics(shapes, maxMinutes, originCoordinate) {
  let area = 0;
  let radius = 0;
  const outerShapes = shapes.filter((shape) => shape.minutes === maxMinutes);
  for (const shape of outerShapes) {
    for (const rings of shape.polygons) {
      if (!rings.length) continue;
      area += Math.max(0, sphericalRingAreaKm2(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + sphericalRingAreaKm2(ring), 0));
      for (const point of rings[0]) radius = Math.max(radius, haversineMeters(originCoordinate, point));
    }
  }
  return { area, radius };
}

function fitReachToMap() {
  if (!map || !reachOverlays.length) return;
  const isMobile = window.innerWidth <= 700;
  const panelHeight = document.querySelector('.control-panel').getBoundingClientRect().height;
  const avoid = isMobile
    ? [58, panelHeight + 28, 18, 18]
    : [58, 30, 420, 30];
  map.setFitView([originMarker, ...reachOverlays], true, avoid, 14);
}

function renderReach(data, maxMinutes) {
  if (map && reachOverlays.length) map.remove(reachOverlays);
  reachOverlays = [];
  const orderedShapes = [...data.shapes].sort((left, right) => right.minutes - left.minutes);

  for (const shape of orderedShapes) {
    const fillOpacity = opacityForTime(shape.minutes);
    for (const rings of shape.polygons) {
      const outerRing = rings[0];
      if (!outerRing || outerRing.length < 3) continue;
      const overlay = new AMap.Polygon({
        path: outerRing,
        strokeColor: BLUE,
        strokeOpacity: shape.minutes === maxMinutes ? 0.7 : 0.28,
        strokeWeight: shape.minutes === maxMinutes ? 1.5 : 0.8,
        fillColor: BLUE,
        fillOpacity,
        bubble: false,
        zIndex: 1000 - shape.minutes,
      });
      map.add(overlay);
      reachOverlays.push(overlay);
    }
  }

  if (!reachOverlays.length) throw new Error('没有找到可绘制的可达边界');
  const originCoordinate = toAmapCoordinate(origin);
  const metrics = polygonMetrics(data.shapes, maxMinutes, originCoordinate);
  elements.areaValue.textContent = formatNumber(metrics.area, metrics.area < 10 ? 1 : 0);
  elements.radiusValue.textContent = metrics.radius ? formatNumber(metrics.radius / 1000, 1) : '—';
  elements.resultTitle.textContent = originName + ' · ' + MODES[activeMode].name + ' · ' + maxMinutes + ' 分钟内';
  elements.legendTitle.innerHTML = '<span class="legend-pin" aria-hidden="true">●</span> ' + MODES[activeMode].source;
  addLegend(maxMinutes);
  fitReachToMap();
  setMapStatus(MODES[activeMode].source + ' · ' + data.shapes.length + ' 个边界 · 查询 ' + data.queryCount + ' 次');
}

async function calculateReach() {
  if (!origin) {
    showToast('先搜索或点击地图设置出发点');
    return;
  }
  if (!map) {
    showToast('高德地图尚未加载，请检查 JS API Key 和安全密钥');
    return;
  }
  const maxMinutes = Number(elements.timeRange.value);
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const thisController = activeController;
  elements.calculateButton.disabled = true;
  elements.calculateButton.textContent = '正在计算可达边界…';
  elements.resultTitle.textContent = activeMode === 'transit' ? '正在查询高德公交到达圈' : '正在计算 OSM 路网等时圈';
  if (map && reachOverlays.length) map.remove(reachOverlays);
  reachOverlays = [];

  try {
    const data = activeMode === 'transit'
      ? await buildTransitReach(maxMinutes, thisController.signal)
      : await buildRoadReach(maxMinutes, thisController.signal);
    if (thisController.signal.aborted) return;
    renderReach(data, maxMinutes);
  } catch (error) {
    if (error.name !== 'AbortError') {
      elements.resultTitle.textContent = '可达边界查询失败';
      setMapStatus('边界查询失败 · 请查看提示并稍后重试');
      showToast(error.message || '可达边界查询失败，请稍后重试', 6500);
    }
  } finally {
    if (activeController === thisController) activeController = null;
    elements.calculateButton.disabled = !origin || !map;
    elements.calculateButton.textContent = '重新计算可达边界';
  }
}

function outsideChina(lng, lat) {
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

function wgs84ToGcj02(lng, lat) {
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

function gcj02ToWgs84(lng, lat) {
  if (outsideChina(lng, lat)) return [lng, lat];
  const shifted = wgs84ToGcj02(lng, lat);
  return [lng * 2 - shifted[0], lat * 2 - shifted[1]];
}

async function searchPlaces(query) {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) {
    showToast('请输入至少两个字的地点');
    return;
  }

  elements.searchResults.hidden = false;
  elements.searchResults.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'search-message';
  loading.textContent = '正在通过高德搜索地点…';
  elements.searchResults.append(loading);

  try {
    const data = await amapGet('/v3/place/text', {
      keywords: cleanQuery,
      offset: 8,
      page: 1,
      extensions: 'base',
    });
    const places = (data.pois || []).filter((poi) => poi.location).slice(0, 8).map((poi) => ({
      name: String(poi.name || ''),
      address: String(poi.address || ''),
      city: [poi.pname, poi.cityname, poi.adname].filter((part) => typeof part === 'string' && part).join(' '),
      location: String(poi.location),
    }));
    elements.searchResults.replaceChildren();
    if (!places.length) {
      const empty = document.createElement('div');
      empty.className = 'search-message';
      empty.textContent = '没有找到地点，换个关键词试试';
      elements.searchResults.append(empty);
      return;
    }

    for (const place of places) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      button.setAttribute('role', 'option');
      const name = document.createElement('strong');
      name.textContent = place.name;
      const address = document.createElement('span');
      address.textContent = place.address || place.city || '';
      button.append(name, address);
      button.addEventListener('click', () => {
        elements.searchResults.hidden = true;
        const [lng, lat] = place.location.split(',').map(Number);
        const [wgsLng, wgsLat] = gcj02ToWgs84(lng, lat);
        placeOrigin({ lat: wgsLat, lng: wgsLng }, place.name);
        map.setZoomAndCenter(14, [lng, lat]);
      });
      elements.searchResults.append(button);
    }
  } catch (error) {
    elements.searchResults.replaceChildren();
    const message = document.createElement('div');
    message.className = 'search-message';
    message.textContent = error.message || '地点搜索失败，请稍后重试';
    elements.searchResults.append(message);
  }
}

elements.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  searchPlaces(elements.searchInput.value);
});

elements.searchInput.addEventListener('input', () => {
  if (!elements.searchInput.value.trim()) elements.searchResults.hidden = true;
});

document.addEventListener('click', (event) => {
  if (!elements.searchForm.contains(event.target)) elements.searchResults.hidden = true;
});

elements.modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    activeMode = button.dataset.mode;
    elements.modeButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    updateTimeControl();
    setModeHint();
    clearResults('出行方式已更改 · 点击按钮重新计算边界');
  });
});

elements.timeRange.addEventListener('input', () => {
  updateTimeLabel();
  clearResults('通勤时间已更改 · 点击按钮重新计算边界');
});

elements.calculateButton.addEventListener('click', calculateReach);
elements.zoomIn.addEventListener('click', () => map?.zoomIn());
elements.zoomOut.addEventListener('click', () => map?.zoomOut());

elements.locateButton.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('此浏览器不支持定位');
    return;
  }
  elements.locateButton.disabled = true;
  setMapStatus('正在获取当前位置…');
  navigator.geolocation.getCurrentPosition((position) => {
    elements.locateButton.disabled = false;
    const coords = { lat: position.coords.latitude, lng: position.coords.longitude };
    placeOrigin(coords, '我的当前位置');
    elements.searchInput.value = '我的当前位置';
    map?.setZoomAndCenter(14, toAmapCoordinate(coords));
  }, (error) => {
    elements.locateButton.disabled = false;
    const message = error.code === error.PERMISSION_DENIED ? '定位权限未开启，请在浏览器设置中允许定位' : '无法获取当前位置，请搜索地点或点击地图';
    setMapStatus('搜索地点或点击地图开始');
    showToast(message, 4500);
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});

initializeMap();
updateTimeControl();
setModeHint();
