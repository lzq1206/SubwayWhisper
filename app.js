'use strict';

const AMAP_WEB_KEY = '9ec9628db5e66650e43dea74f85a8262';
const AMAP_BASE = 'https://restapi.amap.com';
const AMAP_REQUEST_INTERVAL_MS = 1200;
const VALHALLA_ISOCHRONE_URL = 'https://valhalla1.openstreetmap.de/isochrone';
const VALHALLA_CLIENT_ID = 'https://lzq1206.github.io/SubwayWhisper/';
const HERITAGE_SITES_URL = 'data/national-key-cultural-sites.json';
const BLUE = '#2864e8';
const BLUE_HEX = '2864e8';
const LAYER_OPACITIES = [0.31, 0.24, 0.18, 0.145, 0.12, 0.095, 0.075, 0.055];
const HERITAGE_CATEGORY_SHAPES = {
  '古遗址': 'circle',
  '古建筑': 'square',
  '古墓葬': 'diamond',
  '石窟寺及石刻': 'triangle',
  '近现代重要史迹及代表性建筑': 'hexagon',
  '其他': 'circle',
};
const TRANSIT_MAX_MINUTES = 45;
const ROAD_MAX_MINUTES = 60;
const MIN_TIME_MINUTES = 10;
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
let poiHeatmapLayer = null;
let poiHeatmapRefreshTimer = null;
let poiHeatmapRequestId = 0;
let heritageSites = null;
let heritageLoadPromise = null;
let heritageBatchLabels = [];
let heritageCategories = [];
let heritageMassMarks = null;
let heritageLabelMarkers = [];
let heritageInfoWindow = null;
let heritageSitesEnabled = false;
let heritageRenderFrame = 0;

const elements = {
  searchForm: document.querySelector('#search-form'),
  searchInput: document.querySelector('#place-search'),
  searchResults: document.querySelector('#search-results'),
  locateButton: document.querySelector('#locate-button'),
  timeRange: document.querySelector('#time-range'),
  timeValue: document.querySelector('#time-value'),
  timeNote: document.querySelector('#time-note'),
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
  poiHeatmapToggle: document.querySelector('#poi-heatmap-toggle'),
  heritageSitesToggle: document.querySelector('#heritage-sites-toggle'),
  hidePanelButton: document.querySelector('#hide-panel-button'),
  showPanelButton: document.querySelector('#show-panel-button'),
  controlPanel: document.querySelector('#control-panel'),
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
    zoom: 11,
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
  map.on('moveend', scheduleHeritageRender);
  map.on('moveend', schedulePoiHeatmapRefresh);
  map.on('zoomend', schedulePoiHeatmapRefresh);
  map.on('zoomchange', scheduleHeritageRender);
  setMapStatus('高德地图就绪 · 正在根据设备 IP 匹配所在城市');
  initializeIpCityOrigin();
}

function initializeIpCityOrigin() {
  if (!map) return;
  const searchForIpCity = () => {
    if (!AMap.CitySearch) {
      setMapStatus('IP 城市定位不可用 · 搜索地点或点击地图设置出发点');
      return;
    }
    const citySearch = new AMap.CitySearch();
    citySearch.getLocalCity((status, result) => {
      if (origin) return;
      if (status !== 'complete' || result?.info !== 'OK' || !result.bounds?.getCenter) {
        setMapStatus('IP 城市定位不可用 · 搜索地点或点击地图设置出发点');
        return;
      }
      const center = normalizeAmapPoint(result.bounds.getCenter());
      if (!center || !center.every(Number.isFinite)) return;
      const [lng, lat] = gcj02ToWgs84(center[0], center[1]);
      const cityName = String(result.city || 'IP 所在城市').trim();
      const approximateName = cityName + ' · IP 城市范围中心（近似）';
      placeOrigin({ lat, lng }, approximateName);
      elements.searchInput.value = approximateName;
      map.setZoomAndCenter(12, center);
      setMapStatus('IP 城市定位 · ' + cityName + ' · 起点为城市级近似位置');
    });
  };
  if (AMap.CitySearch) searchForIpCity();
  else AMap.plugin('AMap.CitySearch', searchForIpCity);
}

function currentLimit() {
  return activeMode === 'transit' ? TRANSIT_MAX_MINUTES : ROAD_MAX_MINUTES;
}

function updateTimeControl() {
  const max = currentLimit();
  const step = activeMode === 'transit' ? 5 : 10;
  const previousValue = Number(elements.timeRange.value) || 30;
  const boundedValue = Math.min(max, Math.max(MIN_TIME_MINUTES, previousValue));
  const snappedValue = MIN_TIME_MINUTES + Math.round((boundedValue - MIN_TIME_MINUTES) / step) * step;

  elements.timeRange.min = String(MIN_TIME_MINUTES);
  elements.timeRange.max = String(max);
  elements.timeRange.step = String(step);
  elements.timeRange.value = String(Math.min(max, snappedValue));

  const ticks = activeMode === 'transit' ? [10, 20, 30, 40, 45] : [10, 20, 30, 40, 50, 60];
  const tickContainer = document.querySelector('.range-ticks');
  tickContainer.replaceChildren(...ticks.map((tick) => {
    const label = document.createElement('span');
    label.textContent = String(tick);
    label.style.left = ((tick - MIN_TIME_MINUTES) / (max - MIN_TIME_MINUTES) * 100) + '%';
    return label;
  }));
  elements.timeNote.textContent = activeMode === 'transit'
    ? '公交 / 地铁支持 10–45 分钟（5 分钟步进）。'
    : '骑行 / 驾车支持 10–60 分钟（10 分钟步进）。';
  updateTimeLabel();
}

function updateRangeTrack() {
  const min = Number(elements.timeRange.min);
  const max = Number(elements.timeRange.max);
  const value = Number(elements.timeRange.value);
  const percent = ((value - min) / (max - min)) * 100;
  elements.timeRange.style.setProperty('--range-progress', 'calc(' + percent + '% + ' + (8 - 16 * percent / 100) + 'px)');
}

function updateTimeLabel() {
  const maxMinutes = Number(elements.timeRange.value);
  elements.timeValue.innerHTML = maxMinutes + ' <span>分钟</span>';
  updateRangeTrack();
}

function setModeHint() {
  elements.modeHint.textContent = activeMode === 'transit'
    ? '公交范围来自高德官方到达圈，按所选分钟数查询，不指定出发时刻；当前最多 45 分钟。'
    : '范围根据 OpenStreetMap 路网计算；通行速度来自路网模型，不含实时路况。当前公共 Valhalla 服务的等时圈上限为 60 分钟。';
}

function loadAmapPlugins(plugins) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('高德地图插件加载超时，请稍后重试'));
    }, 12000);

    try {
      map.plugin(plugins, () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve();
      });
    } catch (error) {
      window.clearTimeout(timeoutId);
      reject(error);
    }
  });
}

function schedulePoiHeatmapRefresh() {
  if (!elements.poiHeatmapToggle.checked) return;
  ++poiHeatmapRequestId;
  window.clearTimeout(poiHeatmapRefreshTimer);
  poiHeatmapRefreshTimer = window.setTimeout(() => void setPoiHeatmapEnabled(true), 600);
}

function searchHeatmapPage(bounds, pageIndex) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('高德热力图查询超时，请移动地图重试')), 12000);
    const search = new AMap.PlaceSearch({ type: '公园', pageSize: 50, pageIndex, extensions: 'base', showCover: false });
    search.searchInBounds('公园', bounds, (status, result) => {
      window.clearTimeout(timeout);
      if (status === 'no_data') resolve({ pois: [], count: 0 });
      else if (status === 'complete') resolve(result?.poiList || { pois: [], count: 0 });
      else reject(new Error(result?.info || '高德热力图查询失败'));
    });
  });
}

async function searchViewportHeatmapPoints(requestId) {
  const bounds = map.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const midLng = (sw.getLng() + ne.getLng()) / 2;
  const midLat = (sw.getLat() + ne.getLat()) / 2;
  const points = new Map();
  // Split the viewport so a dense city center cannot consume the entire result limit.
  for (const [west, east] of [[sw.getLng(), midLng], [midLng, ne.getLng()]]) {
    for (const [south, north] of [[sw.getLat(), midLat], [midLat, ne.getLat()]]) {
      const cell = new AMap.Bounds([west, south], [east, north]);
      for (let page = 1; page <= 2; page++) {
        if (requestId !== poiHeatmapRequestId) return [];
        const result = await searchHeatmapPage(cell, page);
        for (const poi of result.pois || []) {
          const location = poi.location;
          const lng = Number(location?.getLng?.() ?? location?.lng);
          const lat = Number(location?.getLat?.() ?? location?.lat);
          if (Number.isFinite(lng) && Number.isFinite(lat)) {
            points.set(poi.id || lng + ',' + lat, { lng, lat, count: 1 });
          }
        }
        if ((result.pois || []).length < 50 || Number(result.count) <= page * 50) break;
      }
    }
  }
  return [...points.values()];
}

async function setPoiHeatmapEnabled(enabled) {
  if (!map) return;
  window.clearTimeout(poiHeatmapRefreshTimer);
  const requestId = ++poiHeatmapRequestId;
  if (!enabled) {
    poiHeatmapLayer?.hide();
    return;
  }
  try {
    await loadAmapPlugins(['AMap.Heatmap', 'AMap.PlaceSearch']);
    if (requestId !== poiHeatmapRequestId || !elements.poiHeatmapToggle.checked) return;
    const points = await searchViewportHeatmapPoints(requestId);
    if (requestId !== poiHeatmapRequestId || !elements.poiHeatmapToggle.checked) return;
    if (!poiHeatmapLayer) {
      poiHeatmapLayer = new AMap.Heatmap(map, { radius: 25, opacity: [0, 0.8], zooms: [3, 20], zIndex: 28 });
    }
    poiHeatmapLayer.setDataSet({ data: points, max: 10 });
    poiHeatmapLayer.show();
    showToast(points.length ? '高德热力图已更新：当前视野 ' + points.length + ' 个 POI（最多采样 400 个）' : '当前视野没有可绘制的公园 POI');
  } catch (error) {
    if (requestId !== poiHeatmapRequestId) return;
    poiHeatmapLayer?.hide();
    showToast(error.message || '高德热力图加载失败，请移动地图重试', 6500);
  }
}

async function setHeritageSitesEnabled(enabled) {
  heritageSitesEnabled = enabled;
  if (!enabled) {
    heritageMassMarks?.setMap(null);
    removeHeritageLabelMarkers();
    heritageInfoWindow?.close();
    return;
  }
  if (!map) return;

  setMapStatus('正在加载全国重点文保单位数据…');
  try {
    heritageSites = await loadHeritageSites();
    if (!heritageSitesEnabled || !elements.heritageSitesToggle.checked) return;
    renderHeritageSites();
    setMapStatus('文保单位图层已开启 · ' + heritageSites.length.toLocaleString('zh-CN') + ' 处');
  } catch (error) {
    elements.heritageSitesToggle.checked = false;
    heritageSitesEnabled = false;
    setMapStatus('文保数据加载失败');
    showToast(error.message || '文保单位数据加载失败，请稍后重试', 6500);
  }
}

function loadHeritageSites() {
  if (!heritageLoadPromise) {
    const dataUrl = new URL(HERITAGE_SITES_URL, document.baseURI);
    heritageLoadPromise = fetch(dataUrl, { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) throw new Error('文保单位数据文件暂时无法访问');
        const data = await response.json();
        if (data.schema !== 1 || !Array.isArray(data.records) || !Array.isArray(data.batches) || !Array.isArray(data.categories)) {
          throw new Error('文保单位数据格式无效');
        }
        heritageBatchLabels = data.batches;
        heritageCategories = data.categories;
        const sites = data.records.map((record) => {
          const [wgsLng, wgsLat, name, batchIndex, categoryIndex, period, address, code] = record;
          const [lng, lat] = wgs84ToGcj02(Number(wgsLng), Number(wgsLat));
          if (![lng, lat, batchIndex, categoryIndex].every(Number.isFinite)) return null;
          const batch = heritageBatchLabels[batchIndex];
          const category = heritageCategories[categoryIndex];
          return {
            position: [lng, lat],
            name: String(name || ''),
            batch: String(batch || '未标注'),
            batchIndex: Number(batchIndex),
            category: String(category || '其他'),
            categoryIndex: Number(categoryIndex),
            period: String(period || ''),
            address: String(address || ''),
            code: String(code || ''),
            color: heritageBatchColor(Number(batchIndex), heritageBatchLabels.length),
            styleIndex: Number(batchIndex) * heritageCategories.length + Number(categoryIndex),
          };
        }).filter(Boolean);
        if (!sites.length) throw new Error('文保单位数据中没有可显示的点位');
        return sites;
      })
      .catch((error) => {
        heritageLoadPromise = null;
        throw error;
      });
  }
  return heritageLoadPromise;
}

function heritageBatchColor(index, count) {
  const first = [255, 77, 79];
  const last = [59, 130, 246];
  const ratio = count > 1 ? Math.min(1, Math.max(0, index / (count - 1))) : 0.45;
  return '#' + first.map((start, channel) => Math.round(start + (last[channel] - start) * ratio).toString(16).padStart(2, '0')).join('');
}

function heritageShapeForCategory(category) {
  return HERITAGE_CATEGORY_SHAPES[category] || 'circle';
}

function heritageSvgDataUrl(color, shape, size) {
  const mid = size / 2;
  let mark;
  if (shape === 'square') {
    mark = `<rect x="0" y="0" width="${size}" height="${size}" fill="${color}"/>`;
  } else if (shape === 'diamond') {
    mark = `<polygon points="${mid},0 ${size},${mid} ${mid},${size} 0,${mid}" fill="${color}"/>`;
  } else if (shape === 'triangle') {
    mark = `<polygon points="${mid},0 ${size},${size} 0,${size}" fill="${color}"/>`;
  } else if (shape === 'hexagon') {
    mark = `<polygon points="${size * .25},0 ${size * .75},0 ${size},${mid} ${size * .75},${size} ${size * .25},${size} 0,${mid}" fill="${color}"/>`;
  } else {
    mark = `<circle cx="${mid}" cy="${mid}" r="${mid}" fill="${color}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${mark}</svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

function heritageMassStyles(zoom) {
  const large = zoom >= 8;
  const styles = [];
  for (let batchIndex = 0; batchIndex < heritageBatchLabels.length; batchIndex += 1) {
    const color = heritageBatchColor(batchIndex, heritageBatchLabels.length);
    for (const category of heritageCategories) {
      const shape = heritageShapeForCategory(category);
      const size = shape === 'circle' ? (large ? 7 : 5) : (large ? 10 : 6);
      styles.push({
        url: heritageSvgDataUrl(color, shape, size),
        size: new AMap.Size(size, size),
        anchor: new AMap.Pixel(size / 2, size / 2),
      });
    }
  }
  return styles;
}

function visibleHeritageSites() {
  const bounds = map?.getBounds();
  if (!bounds) return [];
  return heritageSites.filter((site) => bounds.contains(new AMap.LngLat(site.position[0], site.position[1])));
}

function removeHeritageLabelMarkers() {
  if (map && heritageLabelMarkers.length) map.remove(heritageLabelMarkers);
  heritageLabelMarkers = [];
}

function createHeritageLabelMarker(site) {
  const shape = heritageShapeForCategory(site.category);
  const content = '<div class="heritage-site-marker" style="--marker-color:' + site.color + '">' +
    '<span class="heritage-site-marker__dot heritage-site-marker__dot--' + shape + '"></span>' +
    '<span class="heritage-site-marker__name">' + escapeHeritageText(site.name) + '</span></div>';
  const marker = new AMap.Marker({
    position: site.position,
    title: site.name,
    content,
    offset: new AMap.Pixel(-10, -10),
    zIndex: 120,
  });
  marker.on('click', () => openHeritageDetails(site));
  return marker;
}

function renderHeritageSites() {
  if (!heritageSitesEnabled || !map || !heritageSites) return;
  const inView = visibleHeritageSites();
  const useLabels = map.getZoom() >= 10 && inView.length <= 500;
  removeHeritageLabelMarkers();

  if (useLabels) {
    heritageMassMarks?.setMap(null);
    heritageLabelMarkers = inView.map(createHeritageLabelMarker);
    if (heritageLabelMarkers.length) map.add(heritageLabelMarkers);
    return;
  }

  if (typeof AMap.MassMarks !== 'function') {
    showToast('高德海量点图层未加载，无法显示文保单位', 6500);
    return;
  }
  if (!heritageMassMarks) {
    const data = heritageSites.map((site) => ({
      lnglat: site.position,
      style: site.styleIndex,
      name: site.name,
      heritageSite: site,
    }));
    heritageMassMarks = new AMap.MassMarks(data, {
      opacity: 0.95,
      zIndex: 110,
      zooms: [3, 19],
      cursor: 'pointer',
      style: heritageMassStyles(map.getZoom()),
    });
    heritageMassMarks.on('click', (event) => {
      const site = event.data?.heritageSite;
      if (site) openHeritageDetails(site, event.data?.lnglat || site.position);
    });
  } else {
    heritageMassMarks.setStyle(heritageMassStyles(map.getZoom()));
  }
  heritageMassMarks.setMap(map);
}

function scheduleHeritageRender() {
  if (!heritageSitesEnabled || !heritageSites || heritageRenderFrame) return;
  heritageRenderFrame = window.requestAnimationFrame(() => {
    heritageRenderFrame = 0;
    renderHeritageSites();
  });
}

function escapeHeritageText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openHeritageDetails(site, position = site.position) {
  if (!map || !site) return;
  const rows = [
    ['批次', site.batch],
    ['类别', site.category],
    ['年代', site.period],
    ['地址', site.address],
    ['编号', site.code],
  ].filter(([, value]) => value);
  const content = '<div class="heritage-info-card"><strong>' + escapeHeritageText(site.name) + '</strong>' +
    rows.map(([label, value]) => '<p><b>' + label + '：</b>' + escapeHeritageText(value) + '</p>').join('') + '</div>';
  if (!heritageInfoWindow) {
    heritageInfoWindow = new AMap.InfoWindow({ isCustom: true, autoMove: true, offset: new AMap.Pixel(0, -10) });
  }
  heritageInfoWindow.setContent(content);
  heritageInfoWindow.open(map, position);
}

function setControlPanelHidden(hidden) {
  document.querySelector('.map-shell').classList.toggle('panel-hidden', hidden);
  elements.controlPanel.setAttribute('aria-hidden', String(hidden));
  elements.controlPanel.inert = hidden;
  elements.showPanelButton.hidden = !hidden;
  elements.showPanelButton.setAttribute('aria-expanded', String(!hidden));
  if (hidden) elements.showPanelButton.focus();
  else elements.hidePanelButton.focus();
  window.setTimeout(() => map?.resize(), 240);
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
    content: '<svg class="origin-marker" viewBox="0 0 32 40" aria-hidden="true"><path class="origin-marker-body" d="M16 1.5C8.02 1.5 1.55 7.98 1.55 15.95c0 10.15 14.45 22.55 14.45 22.55s14.45-12.4 14.45-22.55C30.45 7.98 23.98 1.5 16 1.5Z"/><circle cx="16" cy="15.5" r="5.5" class="origin-marker-center"/><circle cx="16" cy="15.5" r="2.1" class="origin-marker-dot"/></svg>',
    offset: new AMap.Pixel(-16, -40),
    zIndex: 2000,
  });
  map.add(originMarker);
  if (name) elements.searchInput.value = name;
  elements.calculateButton.disabled = false;
  clearResults('出发点已设置 · 点击地图可更换');
}

function getContourTimes(maxMinutes) {
  const times = [];
  const interval = 10;
  for (let minutes = interval; minutes < maxMinutes; minutes += interval) times.push(minutes);
  if (!times.includes(maxMinutes)) times.push(maxMinutes);
  return times;
}

function opacityForTime(minutes, maxMinutes) {
  const interval = 10;
  const tier = Math.max(1, Math.ceil(minutes / interval));
  return LAYER_OPACITIES[Math.min(tier - 1, LAYER_OPACITIES.length - 1)];
}

function addLegend(maxMinutes) {
  const thresholds = getContourTimes(maxMinutes);
  const interval = 10;
  elements.legendItems.replaceChildren();
  for (let index = 0; index < thresholds.length; index += 1) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = 'rgba(40, 100, 232, ' + opacityForTime(thresholds[index], maxMinutes) + ')';
    const label = document.createElement('span');
    const start = index * interval;
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
      // ArrivalRange can return usable polygons with status "no_data"; follow the official sample and trust bounds.
      if (!Array.isArray(result?.bounds) || !result.bounds.length) {
        const info = result?.info && result.info !== 'OK' ? result.info : '高德没有返回公交可达边界，请换一个出发点或缩短时间';
        reject(new Error(info));
        return;
      }
      const shapes = result.bounds.map((path) => {
        if (!Array.isArray(path) || !path.length) return null;
        const first = path[0];
        const firstIsPoint = Array.isArray(first)
          ? first.length >= 2 && Number.isFinite(Number(first[0])) && Number.isFinite(Number(first[1]))
          : Boolean(first && typeof first.getLng === 'function' && typeof first.getLat === 'function')
            || Boolean(first && Number.isFinite(Number(first.lng)) && Number.isFinite(Number(first.lat)));
        const rings = firstIsPoint ? [path] : path;
        const normalizedRings = rings.map((ring) => Array.isArray(ring)
          ? ring.map(normalizeAmapPoint).filter((point) => point && point.every(Number.isFinite))
          : []).filter((ring) => ring.length >= 3);
        return normalizedRings.length ? { minutes, polygons: [normalizedRings] } : null;
      }).filter(Boolean);
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
  if (maxMinutes > ROAD_MAX_MINUTES) {
    throw new Error('当前公共 Valhalla 服务返回 400（Exceeded max time: 60），不能提供超过 60 分钟的真实路网边界。请配置支持长时段的路网服务后再使用。');
  }
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
  const panelHidden = document.querySelector('.map-shell').classList.contains('panel-hidden');
  const panelHeight = document.querySelector('.control-panel').getBoundingClientRect().height;
  const avoid = isMobile
    ? [58, panelHidden ? 18 : panelHeight + 28, 18, 18]
    : [58, 30, panelHidden ? 30 : 420, 30];
  map.setFitView([originMarker, ...reachOverlays], true, avoid, 14);
}

function renderReach(data, maxMinutes) {
  if (map && reachOverlays.length) map.remove(reachOverlays);
  reachOverlays = [];
  const originCoordinate = toAmapCoordinate(origin);
  const metrics = polygonMetrics(data.shapes, maxMinutes, originCoordinate);
  const orderedShapes = [...data.shapes].sort((left, right) => right.minutes - left.minutes);

  for (const shape of orderedShapes) {
    const fillOpacity = opacityForTime(shape.minutes, maxMinutes);
    for (const rings of shape.polygons) {
      const outerRing = rings[0];
      if (!outerRing || outerRing.length < 3) continue;
      const overlay = new AMap.Polygon({
        path: outerRing.map((point) => point.slice()),
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

elements.timeRange.addEventListener('input', updateTimeLabel);

elements.timeRange.addEventListener('change', () => {
  clearResults('通勤时间已更改 · 点击按钮重新计算边界');
});


elements.poiHeatmapToggle.addEventListener('change', () => {
  void setPoiHeatmapEnabled(elements.poiHeatmapToggle.checked);
});

elements.heritageSitesToggle.addEventListener('change', () => {
  void setHeritageSitesEnabled(elements.heritageSitesToggle.checked);
});

elements.hidePanelButton.addEventListener('click', () => setControlPanelHidden(true));
elements.showPanelButton.addEventListener('click', () => setControlPanelHidden(false));

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
