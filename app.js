'use strict';

const API_BASE = window.SUBWAY_API_BASE || (
  window.location.hostname.endsWith('.pages.dev')
    || window.location.hostname.endsWith('.workers.dev')
    ? window.location.origin + '/api'
    : 'https://subwaywhisper.lzq1206.workers.dev/api'
);
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
  const partialText = data.truncated ? ' · 已达单次查询上限，边缘未完整采样' : '';
  setMapStatus(reachable.length + ' 个网格由高德路线耗时核验 · 网格为抽样' + partialText);
  addLegend(maxMinutes);
  fitCells(reachable, cellMeters);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.error) throw new Error(data.message || '路线服务暂时不可用');
  return data;
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
  setMapStatus('高德路线查询进行中，请稍候');
  reachLayer.clearLayers();

  const body = {
    origin: { lat: origin.lat, lng: origin.lng },
    mode: activeMode,
    maxMinutes,
  };
  if (activeMode === 'transit') {
    body.departure = {
      date: departure.getFullYear() + '-' + String(departure.getMonth() + 1).padStart(2, '0') + '-' + String(departure.getDate()).padStart(2, '0'),
      time: String(departure.getHours()).padStart(2, '0') + '-' + String(departure.getMinutes()).padStart(2, '0'),
    };
  }

  try {
    const data = await requestJson(API_BASE + '/isochrone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: thisController.signal,
    });
    if (thisController.signal.aborted) return;
    if (!data.cells || data.cells.length === 0) throw new Error('高德没有返回可用路线，请换一个出发点或出发时间');
    renderReach(data);
  } catch (error) {
    if (error.name !== 'AbortError') {
      elements.resultTitle.textContent = '路线范围查询失败';
      setMapStatus('请检查 Cloudflare Pages 的 AMAP_WEB_KEY 配置和路线 API 权限');
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
    const params = new URLSearchParams({ keywords: cleanQuery });
    const data = await requestJson(API_BASE + '/search?' + params.toString());
    const places = Array.isArray(data.places) ? data.places : [];
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
    message.textContent = error.message || '地点搜索失败，请确认 Cloudflare API 已部署';
    elements.searchResults.append(message);
  }
}

function setDefaultDeparture() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  elements.departureTime.value = local.toISOString().slice(0, 16);
}

async function checkBackend() {
  try {
    const data = await requestJson(API_BASE + '/health');
    setMapStatus(data.ready ? '高德路线服务已连接 · 搜索或点击地图开始' : '请在 Cloudflare Pages 添加加密变量 AMAP_WEB_KEY');
  } catch {
    setMapStatus('等待 Cloudflare Pages API 部署 · 搜索或点击地图可先设置出发点');
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
    elements.departureField.hidden = activeMode !== 'transit';
    clearResults('出行方式已更改 · 点击按钮重新查询高德路线');
  });
});

elements.timeRange.addEventListener('input', () => {
  updateTimeLabel();
  clearResults('通勤时间已更改 · 点击按钮重新查询高德路线');
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
elements.departureField.hidden = activeMode !== 'transit';
checkBackend();
