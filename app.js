'use strict';

const AMAP_WEB_KEY = '9ec9628db5e66650e43dea74f85a8262';
const AMAP_BASE = 'https://restapi.amap.com';
const AMAP_REQUEST_INTERVAL_MS = 1200;
const GRID_PROFILES = {
  coarse: { label: '大网格', multiplier: 2, maxSamples: 8 },
  medium: { label: '中网格', multiplier: 1.5, maxSamples: 12 },
  fine: { label: '小网格', multiplier: 1, maxSamples: 16 },
};
let amapRequestQueue = Promise.resolve();
let lastAmapRequestStartedAt = 0;
const MODES = {
  transit: { name: '公交 / 地铁' },
  bike: { name: '骑行' },
  car: { name: '驾车' },
};
const LAYER_OPACITIES = [0.31, 0.24, 0.18, 0.13, 0.09, 0.055];
const BLUE = '#2864e8';
const elements = {
  searchForm: document.querySelector('#search-form'),
  searchInput: document.querySelector('#place-search'),
  searchResults: document.querySelector('#search-results'),
  locateButton: document.querySelector('#locate-button'),
  timeRange: document.querySelector('#time-range'),
  timeValue: document.querySelector('#time-value'),
  gridSize: document.querySelector('#grid-size'),
  gridValue: document.querySelector('#grid-value'),
  departureField: document.querySelector('#departure-field'),
  departureTime: document.querySelector('#departure-time'),
  calculateButton: document.querySelector('#calculate-button'),
  modeButtons: [...document.querySelectorAll('.mode-card')],
  resultTitle: document.querySelector('#result-title'),
  areaValue: document.querySelector('#area-value'),
  radiusValue: document.querySelector('#radius-value'),
  legend: document.querySelector('#legend'),
  legendItems: document.querySelector('#legend-items'),
  mapStatus: document.querySelector('#map-status'),
  toast: document.querySelector('#toast'),
};

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([31.2304, 121.4737], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noreferrer\">OpenStreetMap</a>',
}).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

const reachLayer = L.layerGroup().addTo(map);
const originLayer = L.layerGroup().addTo(map);
let origin = null;
let originName = '';
let activeMode = 'transit';
let toastTimeout = 0;
let activeController = null;

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

function currentGridProfile() {
  return GRID_PROFILES[elements.gridSize.value] || GRID_PROFILES.coarse;
}

function currentCellMeters() {
  const scale = { transit: 100, bike: 90, car: 160 }[activeMode];
  const rawSize = Number(elements.timeRange.value) * scale * currentGridProfile().multiplier;
  return Math.max(600, Math.round(rawSize / 100) * 100);
}

function updateGridLabel() {
  const cellKm = currentCellMeters() / 1000;
  const profile = currentGridProfile();
  elements.gridValue.textContent = cellKm.toFixed(1) + ' km 边长 · 最多 ' + profile.maxSamples + ' 个路线点';
}

function amapErrorMessage(code, info) {
  const messages = {
    '10001': '高德 Key 无效或已过期',
    '10002': '当前 Key 没有该 Web 服务接口权限',
    '10003': '高德接口今日调用量已达上限',
    '10004': '高德接口请求过于频繁，请稍后再试',
    '10009': '该 Key 平台类型与 Web 服务不匹配',
    '10021': '高德账号接口 QPS 已超限，请稍后再试或减少同时使用人数',
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

function clearResults(message = '设置出发点后计算真实路线范围') {
  if (activeController) activeController.abort();
  activeController = null;
  reachLayer.clearLayers();
  elements.areaValue.textContent = '—';
  elements.radiusValue.textContent = '—';
  elements.legend.hidden = true;
  elements.calculateButton.disabled = !origin;
  elements.calculateButton.textContent = '计算真实路线范围';
  elements.resultTitle.textContent = origin ? '等待计算高德路线数据' : '等待选择出发点';
  setMapStatus(message);
}

function placeOrigin(latlng, name = '') {
  origin = L.latLng(Number(latlng.lat), Number(latlng.lng));
  originName = name.trim() || origin.lat.toFixed(4) + ', ' + origin.lng.toFixed(4);
  originLayer.clearLayers();

  const marker = L.marker(origin, {
    keyboard: true,
    title: originName || '出发点',
    icon: L.divIcon({ className: '', html: '<span class=\"origin-marker\"></span>', iconSize: [24, 24], iconAnchor: [12, 24] }),
  });
  marker.bindTooltip(originName || '出发点', { direction: 'top', offset: [0, -17], opacity: 0.92 });
  originLayer.addLayer(marker);
  if (name) elements.searchInput.value = name;
  elements.calculateButton.disabled = false;
  clearResults('出发点已设置 · 点击地图可更换');
}

function addLegend(maxMinutes) {
  const tiers = Math.ceil(maxMinutes / 10);
  elements.legendItems.replaceChildren();
  for (let tier = 1; tier <= tiers; tier += 1) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = 'rgba(40, 100, 232, ' + LAYER_OPACITIES[tier - 1] + ')';
    const label = document.createElement('span');
    label.textContent = tier === 1 ? '0–10 分钟' : (tier - 1) * 10 + '–' + tier * 10 + ' 分钟';
    item.append(swatch, label);
    elements.legendItems.append(item);
  }
  elements.legend.hidden = false;
}

function fitCells(cells, cellMeters) {
  if (!cells.length || !origin) return;
  const points = [[origin.lat, origin.lng]];
  for (const cell of cells) {
    const latDelta = cellMeters / 111320 / 2;
    const lngDelta = latDelta / Math.max(0.15, Math.cos((cell.lat * Math.PI) / 180));
    points.push(
      [cell.lat - latDelta, cell.lng - lngDelta],
      [cell.lat + latDelta, cell.lng + lngDelta],
    );
  }
  const isNarrow = window.innerWidth <= 700;
  const panelHeight = document.querySelector('.control-panel').getBoundingClientRect().height;
  map.fitBounds(points, {
    paddingTopLeft: isNarrow ? [14, 18] : [420, 56],
    paddingBottomRight: isNarrow ? [14, panelHeight + 42] : [30, 30],
    maxZoom: 15,
    animate: false,
  });
}

function renderReach(data) {
  const maxMinutes = Number(elements.timeRange.value);
  const cellMeters = Number(data.cellMeters);
  const cells = Array.isArray(data.cells) ? data.cells : [];
  const reachable = cells.filter((cell) => Number.isFinite(Number(cell.durationSeconds)) && Number(cell.durationSeconds) <= maxMinutes * 60);
  reachLayer.clearLayers();

  for (const cell of reachable) {
    const tier = Math.max(1, Math.ceil(Number(cell.durationSeconds) / 600));
    const halfLat = cellMeters / 2 / 111320;
    const halfLng = halfLat / Math.max(0.15, Math.cos((Number(cell.lat) * Math.PI) / 180));
    const opacity = LAYER_OPACITIES[Math.min(tier - 1, LAYER_OPACITIES.length - 1)];
    L.rectangle([
      [Number(cell.lat) - halfLat, Number(cell.lng) - halfLng],
      [Number(cell.lat) + halfLat, Number(cell.lng) + halfLng],
    ], {
      color: BLUE,
      weight: 0.6,
      opacity: 0.12 + opacity * 0.2,
      fillColor: BLUE,
      fillOpacity: opacity,
      interactive: false,
    }).addTo(reachLayer);
  }

  const sampleArea = reachable.length * cellMeters * cellMeters / 1_000_000;
  const maxRouteDistance = reachable.reduce((max, cell) => Math.max(max, Number(cell.distanceMeters) || 0), 0);
  elements.areaValue.textContent = formatNumber(sampleArea, sampleArea < 10 ? 1 : 0);
  elements.radiusValue.textContent = maxRouteDistance ? formatNumber(maxRouteDistance / 1000, 1) : '—';
  const mode = MODES[activeMode];
  elements.resultTitle.textContent = originName + ' · ' + mode.name + ' · ' + maxMinutes + ' 分钟内';
  const partialText = data.truncated ? ' · 已达采样上限，边缘未完整采样' : '';
  setMapStatus(reachable.length + ' 个网格由高德路线耗时核验 · 查询 ' + data.queryCount + ' 个路线点 · 边长 ' + (cellMeters / 1000).toFixed(1) + ' km' + partialText);
  addLegend(maxMinutes);
  fitCells(reachable, cellMeters);
}

function getRouteDetails(data, mode) {
  const choices = mode === 'transit' ? (data.route?.transits || []) : (data.route?.paths || []);
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

async function cityCodeForOrigin(point, signal) {
  const [lng, lat] = wgs84ToGcj02(point.lng, point.lat);
  const data = await amapGet('/v3/geocode/regeo', {
    location: lng.toFixed(6) + ',' + lat.toFixed(6),
    extensions: 'base',
  }, signal);
  const rawCode = data.regeocode?.addressComponent?.citycode;
  const cityCode = Array.isArray(rawCode) ? rawCode[0] : rawCode;
  if (!cityCode) throw new Error('无法识别出发点所在城市，请重新选择地图位置');
  return String(cityCode);
}

async function queryRoute(start, destination, mode, cityCode, departure, signal) {
  const [originLng, originLat] = wgs84ToGcj02(start.lng, start.lat);
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
  const data = await amapGet(path, params, signal);
  return getRouteDetails(data, mode);
}

function gridPoint(center, row, column, cellMeters) {
  const latitude = center.lat + row * cellMeters / 111320;
  const metersPerDegreeLongitude = Math.max(10000, 111320 * Math.cos(center.lat * Math.PI / 180));
  const longitude = center.lng + column * cellMeters / metersPerDegreeLongitude;
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

function selectSamples(points, count) {
  const ordered = [...points].sort((left, right) => Math.atan2(left[0], left[1]) - Math.atan2(right[0], right[1]));
  if (ordered.length <= count) return ordered;
  const selected = [];
  for (let index = 0; index < count; index += 1) {
    selected.push(ordered[Math.floor((index + 0.5) * ordered.length / count)]);
  }
  return selected;
}

async function buildReachData(maxMinutes, departure, signal) {
  const profile = currentGridProfile();
  const cellMeters = currentCellMeters();
  const cityCode = activeMode === 'transit' ? await cityCodeForOrigin(origin, signal) : '';
  const cells = [{ row: 0, column: 0, lat: origin.lat, lng: origin.lng, durationSeconds: 0, distanceMeters: 0 }];
  const seen = new Set(['0,0']);
  let frontier = neighbors(0, 0);
  for (const [row, column] of frontier) seen.add(row + ',' + column);
  let sampleCount = 0;
  let truncated = false;

  while (frontier.length && sampleCount < profile.maxSamples) {
    const available = profile.maxSamples - sampleCount;
    const batch = selectSamples(frontier, Math.min(frontier.length, available));
    const skippedAtThisEdge = batch.length < frontier.length;
    const nextFrontier = [];
    for (const [row, column] of batch) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const point = gridPoint(origin, row, column, cellMeters);
      const route = outsideChina(point.lng, point.lat)
        ? null
        : await queryRoute(origin, point, activeMode, cityCode, departure, signal);
      sampleCount += 1;
      const cell = {
        row,
        column,
        lat: point.lat,
        lng: point.lng,
        durationSeconds: route?.durationSeconds ?? null,
        distanceMeters: route?.distanceMeters ?? 0,
      };
      cells.push(cell);
      if (cell.durationSeconds === null || cell.durationSeconds > maxMinutes * 60) continue;
      for (const [nextRow, nextColumn] of neighbors(row, column)) {
        const id = nextRow + ',' + nextColumn;
        if (seen.has(id)) continue;
        seen.add(id);
        nextFrontier.push([nextRow, nextColumn]);
      }
    }
    truncated = skippedAtThisEdge || nextFrontier.length > 0;
    frontier = nextFrontier;
  }

  return {
    cellMeters,
    queryCount: sampleCount,
    sampleLimit: profile.maxSamples,
    truncated,
    cells,
  };
}

async function calculateReach() {
  if (!origin) {
    showToast('先搜索或点击地图设置出发点');
    return;
  }
  const maxMinutes = Number(elements.timeRange.value);
  const departure = new Date(elements.departureTime.value);
  if (activeMode === 'transit' && Number.isNaN(departure.getTime())) {
    showToast('请先选择公交出发时间');
    return;
  }

  if (activeController) activeController.abort();
  activeController = new AbortController();
  const thisController = activeController;
  elements.calculateButton.disabled = true;
  elements.calculateButton.textContent = '正在查询高德路线…';
  elements.resultTitle.textContent = '正在逐格计算实际路线时间';
  setMapStatus('正在向高德串行发送路线请求，降低接口调用频率');
  reachLayer.clearLayers();
  const departureParams = {
    date: departure.getFullYear() + '-' + String(departure.getMonth() + 1).padStart(2, '0') + '-' + String(departure.getDate()).padStart(2, '0'),
    time: String(departure.getHours()).padStart(2, '0') + '-' + String(departure.getMinutes()).padStart(2, '0'),
  };

  try {
    const data = await buildReachData(maxMinutes, departureParams, thisController.signal);
    if (thisController.signal.aborted) return;
    if (!data.cells || data.cells.length <= 1) throw new Error('高德没有返回可用路线，请换一个出发点或出发时间');
    renderReach(data);
  } catch (error) {
    if (error.name !== 'AbortError') {
      elements.resultTitle.textContent = '路线范围查询失败';
      setMapStatus('路线查询失败 · 请查看提示并稍后重试');
      showToast(error.message || '路线范围查询失败，请稍后重试', 6000);
    }
  } finally {
    if (activeController === thisController) activeController = null;
    elements.calculateButton.disabled = !origin;
    elements.calculateButton.textContent = '重新计算真实路线范围';
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
        const [lng, lat] = String(place.location).split(',').map(Number);
        const [wgsLng, wgsLat] = gcj02ToWgs84(lng, lat);
        placeOrigin({ lat: wgsLat, lng: wgsLng }, place.name);
        map.setView([wgsLat, wgsLng], 14, { animate: false });
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

function setDefaultDeparture() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  elements.departureTime.value = local.toISOString().slice(0, 16);
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
    elements.departureField.hidden = activeMode !== 'transit';
    updateGridLabel();
    clearResults('出行方式已更改 · 点击按钮重新查询高德路线');
  });
});

elements.timeRange.addEventListener('input', () => {
  updateTimeLabel();
  updateGridLabel();
  clearResults('通勤时间已更改 · 点击按钮重新查询高德路线');
});

elements.gridSize.addEventListener('change', () => {
  updateGridLabel();
  clearResults('网格尺寸已更改 · 点击按钮重新查询高德路线');
});

elements.departureTime.addEventListener('change', () => {
  clearResults('公交出发时间已更改 · 点击按钮重新查询高德路线');
});

elements.calculateButton.addEventListener('click', calculateReach);

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
    map.setView([coords.lat, coords.lng], 14, { animate: false });
  }, (error) => {
    elements.locateButton.disabled = false;
    const message = error.code === error.PERMISSION_DENIED ? '定位权限未开启，请在浏览器设置中允许定位' : '无法获取当前位置，请搜索地点或点击地图';
    setMapStatus('搜索地点或点击地图开始');
    showToast(message, 4500);
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});

map.on('click', (event) => {
  placeOrigin(event.latlng);
  elements.searchInput.value = event.latlng.lat.toFixed(4) + ', ' + event.latlng.lng.toFixed(4);
  showToast('出发点已更新');
});

setDefaultDeparture();
updateTimeLabel();
updateGridLabel();
elements.departureField.hidden = activeMode !== 'transit';
setMapStatus(AMAP_WEB_KEY === '9ec9628db5e66650e43dea74f85a8262' ? '尚未配置高德 Web 服务 Key' : '高德 Web 服务已就绪 · 搜索或点击地图开始');
