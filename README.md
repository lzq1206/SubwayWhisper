# SubwayWhisper · 城市通勤圈

基于 GitHub Pages 的交互式通勤等时圈地图。首次打开时按设备 IP 获取所在城市级位置并设置一个可调整的近似起点；也可以搜索或点击地图选择地点。地图按所选出行方式显示半透明边界，并支持可选的夜间灯光与实时路况叠加。

## 可达范围数据

- **公交 / 地铁**：使用高德地图 JS API 的 `AMap.ArrivalRange` 官方到达圈多边形，默认公交与地铁组合。该能力按时长查询，不支持指定某天某时刻；当前界面限 45 分钟。
- **骑行 / 驾车**：使用 Valhalla 根据 OpenStreetMap 路网生成 GeoJSON 等时圈多边形，驾车使用 `auto`，骑行使用 `bicycle`。目前使用的公共服务经实测将等时圈限制在 60 分钟；90、120、180、240 分钟选项暂时禁用，避免显示虚构或外推的道路边界。启用长时段服务后，长时段边界按 30 分钟间隔绘制。
- **地图底图**：使用高德地图 JS API 标准底图。高德 JS API 当前没有单独的公交专用地理底图样式；地图保留默认道路、兴趣点与公交 / 地铁站点标注，通勤边界作为半透明覆盖层绘制。
- 面积根据最外层多边形计算，仅用于概览。Valhalla 公共演示服务遵循公平使用限制，服务繁忙或限流时可以稍后重试；公开应用请求带有 `X-Client-Id` 标识。
- **IP 初始位置**：高德 `AMap.CitySearch` 按 IP 返回城市与城市范围；初始标记采用返回范围中心，只是城市级近似点，不等同设备 GPS 定位。搜索街道或点击地图可修正出发点。
- **光污染参考图**：默认关闭；开启后叠加 NASA GIBS 的 2012 VIIRS 夜间灯光图，透明度约 48%。它是历史卫星灯光参考，不是实时天空亮度或精确地面光污染测量。
- **交通热力图**：默认关闭；开启后叠加高德实时路况图层，显示道路拥堵颜色，透明度约 58%。这是道路交通状态图层，不是人口或生活设施密度图。
- **菜单**：可隐藏控制面板，并通过地图左上角按钮重新打开。

## 高德 Key

按站点所有者要求，Web 服务 Key、Web 端 JS API Key 和 JS API 安全密钥均由前端直接使用。它们会出现在公开仓库源代码及浏览器请求中。请在高德控制台绑定 GitHub Pages 域名并监控额度；如果不再希望公开，须在高德控制台轮换这些凭据后再改为服务端代理。

- [高德 JS API Key 准备](https://lbs.amap.com/api/javascript-api-v2/prerequisites)
- [高德 JS API 安全密钥](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [高德公交到达圈参考](https://lbs.amap.com/api/javascript-api/reference/route-search)
- [Valhalla 等时圈 API](https://valhalla.github.io/valhalla/api/isochrone/)
- [Valhalla 演示服务说明](https://github.com/valhalla/valhalla)
- [NASA GIBS 服务说明](https://nasa-gibs.github.io/gibs-api-docs/access-basics/)
- [NASA VIIRS 夜间灯光说明](https://github.com/nasa-gibs/worldview-options-eosdis/blob/master/common/config/metadata/viirs/EarthAtNight.md)

## 本地预览

在仓库根目录运行任意静态 HTTP 服务，例如：

~~~sh
python -m http.server 8000
~~~

打开 `http://127.0.0.1:8000/`。GitHub Pages 使用 `main` 分支根目录，推送后会自动发布。
