'use strict';

const MODES = {
  transit: { name: '公交 / 地铁', speedKmh: 13.5, overheadMin: 6, cellMeters: 360 },
  bike: { name: '骑行', speedKmh: 15.5, overheadMin: 0, cellMeters: 320 },
  car: { name: '驾车', speedKmh: 25, overheadMin: 5, cellMeters: 440 },
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
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
}).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

const reachLayer = L.layerGroup().addTo(map);
const originLayer = L.layerGroup().addTo(map);
let origin = null;
let originName = '';
let activeMode = 'transit';
let toastTimeout = 0;
let lastGeocodeAt = 0;

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);
}

function showToast(message, duration = 3500) {
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
  elements.timeRange.style.setProperty('--range-progress', `${percent}%`);
}

function placeOrigin(latlng, name = '') {
  origin = L.latLng(latlng.lat, latlng.lng);
  originName = name.trim();
  originLayer.clearLayers();

  const marker = L.marker(origin, {
    keyboard: true,
    title: originName || '出发点',
    icon: L.divIcon({ className: '', html: '<span class="origin-marker"></span>', iconSize: [24, 24], iconAnchor: [12, 24] }),
  });
  marker.bindTooltip(originName || '出发点', { direction: 'top', offset: [0, -17], opacity: 0.92 });
  originLayer.addLayer(marker);
  if (!name) originName = `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}`;

  if (name) elements.searchInput.value = name;
  setMapStatus('出发点已设置 · 点击地图可更换');
  renderReach();
}

function addLegend(maxMinutes) {
  const tiers = Math.ceil(maxMinutes / 10);
  elements.legendItems.replaceChildren();
  for (let tier = 1; tier <= tiers; tier += 1) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = `rgba(40, 100, 232, ${LAYER_OPACITIES[tier - 1]})`;
    const label = document.createElement('span');
    label.textContent = tier === 1 ? '0–10 分钟' : `${(tier - 1) * 10}–${tier * 10} 分钟`;
    item.append(swatch, label);
    elements.legendItems.append(item);
  }
  elements.legend.hidden = false;
}

function fitReachBounds(radiusMeters, cellMeters) {
  const edge = radiusMeters + cellMeters / 2;
  const latDelta = edge / 111_320;
  const lngDelta = edge / Math.max(10_000, 111_320 * Math.cos((origin.lat * Math.PI) / 180));
  const isNarrow = window.innerWidth <= 700;
  const panelHeight = document.querySelector('.control-panel').getBoundingClientRect().height;
  map.fitBounds([
    [origin.lat - latDelta, origin.lng - lngDelta],
    [origin.lat + latDelta, origin.lng + lngDelta],
  ], {
    paddingTopLeft: isNarrow ? [14, 18] : [420, 56],
    paddingBottomRight: isNarrow ? [14, panelHeight + 42] : [30, 30],
    maxZoom: 15,
    animate: false,
  });
}

function renderReach() {
  const maxMinutes = Number(elements.timeRange.value);
  elements.timeValue.innerHTML = `${maxMinutes} <span>分钟</span>`;
  updateRangeTrack();
  if (!origin) {
    elements.resultTitle.textContent = '等待选择出发点';
    elements.areaValue.textContent = '—';
    elements.radiusValue.textContent = '—';
    elements.legend.hidden = true;
    reachLayer.clearLayers();
    return;
  }

  const mode = MODES[activeMode];
  const effectiveMinutes = Math.max(0, maxMinutes - mode.overheadMin);
  const radiusMeters = effectiveMinutes * mode.speedKmh * (1000 / 60);
  const cellMeters = mode.cellMeters;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = Math.max(10_000, metersPerDegreeLat * Math.cos((origin.lat * Math.PI) / 180));
  const cellLat = cellMeters / metersPerDegreeLat;
  const cellLng = cellMeters / metersPerDegreeLng;
  const bound = Math.ceil(radiusMeters / cellMeters) + 1;
  const tierLimit = Math.ceil(maxMinutes / 10);
  const areaPerCell = (cellMeters * cellMeters) / 1_000_000;
  let area = 0;
  let cellCount = 0;

  reachLayer.clearLayers();
  for (let row = -bound; row <= bound; row += 1) {
    const north = origin.lat + (row + 0.5) * cellLat;
    const south = origin.lat + (row - 0.5) * cellLat;
    const northMeters = (row + 0.5) * cellMeters;
    const southMeters = (row - 0.5) * cellMeters;
    for (let col = -bound; col <= bound; col += 1) {
      const eastMeters = (col + 0.5) * cellMeters;
      const westMeters = (col - 0.5) * cellMeters;
      const distanceMeters = Math.hypot((eastMeters + westMeters) / 2, (northMeters + southMeters) / 2);
      const travelMinutes = mode.overheadMin + (distanceMeters / 1000 / mode.speedKmh) * 60;
      if (travelMinutes > maxMinutes) continue;

      const tier = Math.max(1, Math.ceil(travelMinutes / 10));
      if (tier > tierLimit) continue;
      const west = origin.lng + col * cellLng;
      const east = origin.lng + (col + 1) * cellLng;
      const opacity = LAYER_OPACITIES[tier - 1];
      L.rectangle([[south, west], [north, east]], {
        color: BLUE,
        weight: 0.45,
        opacity: 0.1 + opacity * 0.2,
        fillColor: BLUE,
        fillOpacity: opacity,
        interactive: false,
      }).addTo(reachLayer);
      area += areaPerCell;
      cellCount += 1;
    }
  }

  const displayName = originName || `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}`;
  elements.resultTitle.textContent = `${displayName} · ${mode.name} · ${maxMinutes} 分钟内`;
  elements.areaValue.textContent = formatNumber(area, area < 10 ? 1 : 0);
  elements.radiusValue.textContent = formatNumber(radiusMeters / 1000, 1);
  setMapStatus(`${cellCount.toLocaleString('zh-CN')} 个网格 · 估算范围`);
  addLegend(maxMinutes);
  fitReachBounds(radiusMeters, cellMeters);
}

async function waitForGeocoderSlot() {
  const wait = Math.max(0, 1050 - (Date.now() - lastGeocodeAt));
  if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
  lastGeocodeAt = Date.now();
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
  loading.textContent = '正在搜索地点…';
  elements.searchResults.append(loading);

  try {
    await waitForGeocoderSlot();
    const params = new URLSearchParams({ q: cleanQuery, format: 'jsonv2', addressdetails: '1', limit: '5', 'accept-language': 'zh-CN' });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('地点搜索暂时不可用');
    const places = await response.json();
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
      name.textContent = place.name || place.display_name.split(',')[0];
      const address = document.createElement('span');
      address.textContent = place.display_name;
      button.append(name, address);
      button.addEventListener('click', () => {
        elements.searchResults.hidden = true;
        const title = place.name || place.display_name.split(',')[0];
        placeOrigin({ lat: Number(place.lat), lng: Number(place.lon) }, title);
      });
      elements.searchResults.append(button);
    }
  } catch (error) {
    elements.searchResults.replaceChildren();
    const message = document.createElement('div');
    message.className = 'search-message';
    message.textContent = error.message || '地点搜索失败，请稍后再试';
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
    renderReach();
  });
});

elements.timeRange.addEventListener('input', renderReach);

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
  }, (error) => {
    elements.locateButton.disabled = false;
    const message = error.code === error.PERMISSION_DENIED ? '定位权限未开启，请在浏览器设置中允许定位' : '无法获取当前位置，请搜索地点或点击地图';
    setMapStatus('搜索地点或点击地图开始');
    showToast(message, 4500);
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});

map.on('click', async (event) => {
  placeOrigin(event.latlng);
  elements.searchInput.value = `${event.latlng.lat.toFixed(4)}, ${event.latlng.lng.toFixed(4)}`;
  showToast('出发点已更新');
});

renderReach();
