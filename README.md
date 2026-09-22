# SubwayWhisper · 城市通勤圈

基于 GitHub Pages 的交互式通勤等时圈地图。首次打开时按设备 IP 获取所在城市级位置并设置一个可调整的近似起点；也可以搜索或点击地图选择地点。地图按所选出行方式显示半透明边界，并支持天空亮度、公园热力和全国重点文保单位等可并行开启的叠加图层。

## 可达范围数据

- **公交 / 地铁**：使用高德地图 JS API 的 `AMap.ArrivalRange` 官方到达圈多边形，默认公交与地铁组合。该能力按时长查询，不支持指定某天某时刻；当前界面限 45 分钟。
- **时间选择**：使用拖动条。公交 / 地铁为 10–45 分钟、每 5 分钟一步；骑行 / 驾车为 10–60 分钟、每 10 分钟一步。界面不提供公共路网服务暂不支持的 60 分钟以上范围。
- **骑行 / 驾车**：使用 Valhalla 根据 OpenStreetMap 路网生成 GeoJSON 等时圈多边形，驾车使用 `auto`，骑行使用 `bicycle`。目前公共服务将等时圈限制在 60 分钟；不会用估算边界替代路网结果。
- **地图底图**：使用高德地图 JS API 标准底图。高德 JS API 当前没有单独的公交专用地理底图样式；地图保留默认道路、兴趣点与公交 / 地铁站点标注，通勤边界作为半透明覆盖层绘制。
- 面积根据最外层多边形计算，仅用于概览。Valhalla 公共演示服务遵循公平使用限制，服务繁忙或限流时可以稍后重试；公开应用请求带有 `X-Client-Id` 标识。
- **IP 初始位置**：高德 `AMap.CitySearch` 按 IP 返回城市与城市范围；初始标记采用返回范围中心，只是城市级近似点，不等同设备 GPS 定位。搜索街道或点击地图可修正出发点。
- **天空亮度 2025**：默认关闭；开启后通过 Light Pollution Map 的 `SB_2025` WMS 图层叠加官方 `WA` 样式，透明度 60%，不限制在低缩放级别。Sky Brightness 是基于 NASA Black Marble 2.0 夜间灯光、地形及校准生成的模型参考值，不是实时天空测量；显示时应注明来源为 Jurij Stare / lightpollutionmap.info 和 NASA Black Marble。
- **高德公园热力图**：默认关闭；开启后加载高德 `AMap.Heatmap` 和 `AMap.PlaceSearch` 插件，搜索地图中心周边 5 公里的公园 POI，以高德自有数据图层绘制热力。此图层反映公园 POI 分布，不表示实时交通拥堵；重新开关时按当时地图中心刷新点位。
- 所有叠加图层有独立开关，可同时选择；天空亮度图层位于热力图下方，等时圈和文保标记继续位于上层。
- **天空亮度服务限制**：Light Pollution Map 当前前端包含 `SB_2025`，本项目据此连接 `tiles/wms`。部署前的命令行瓦片请求返回 HTTP 403；其帮助页目前说明可下载渲染 GeoTIFF，但没有列出公开 WMS/WMTS 服务。因此 GitHub Pages 上能否取到该图层仍需在实际浏览器确认；若显示空白，需要数据方开放 WMS 跨站访问或提供天空亮度 2025 的渲染数据。
- **全国重点文保单位**：默认关闭；开启后按 [CulturalWhisper](https://github.com/lzq1206/CulturalWhisper) 的显示规则绘制 5,066 个点位：颜色从红到蓝对应第一批至第八批，圆形、方形、菱形、三角形和六边形对应文物类别；放大至城市级且可见点位不拥挤时显示名称。数据依据 [国家文物局全国重点文物保护单位名单](https://gl.ncha.gov.cn/#/public-service)，覆盖 1961–2019 年公布批次。数据文件按需加载，坐标在前端转换为高德地图使用的 GCJ-02 坐标。
- **菜单**：可隐藏控制面板，并通过地图左上角按钮重新打开。

## 高德 Key

按站点所有者要求，Web 服务 Key、Web 端 JS API Key 和 JS API 安全密钥均由前端直接使用。它们会出现在公开仓库源代码及浏览器请求中。请在高德控制台绑定 GitHub Pages 域名并监控额度；如果不再希望公开，须在高德控制台轮换这些凭据后再改为服务端代理。

- [高德 JS API Key 准备](https://lbs.amap.com/api/javascript-api-v2/prerequisites)
- [高德 JS API 安全密钥](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [高德自有数据热力图示例](https://lbs.amap.com/demo/javascript-api/example/selflayer/heatmap)
- [高德 PlaceSearch 参考](https://lbs.amap.com/api/maps-javascript-api/reference/search/placesearch)
- [高德公交到达圈参考](https://lbs.amap.com/api/javascript-api/reference/route-search)
- [Valhalla 等时圈 API](https://valhalla.github.io/valhalla/api/isochrone/)
- [Valhalla 演示服务说明](https://github.com/valhalla/valhalla)
- [Light Pollution Map 帮助与数据说明](https://www.lightpollutionmap.info/help.html)
- [NASA Black Marble 产品说明](https://viirsland.gsfc.nasa.gov/Products/NASA/BlackMarble.html)

## 本地预览

在仓库根目录运行任意静态 HTTP 服务，例如：

~~~sh
python -m http.server 8000
~~~

打开 `http://127.0.0.1:8000/`。GitHub Pages 使用 `main` 分支根目录，推送后会自动发布。
