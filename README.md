# SubwayWhisper · 城市通勤圈

基于 GitHub Pages 的交互式通勤等时圈地图。搜索或点击地图设置出发点，选择公交 / 地铁、骑行或驾车，再选择最长出行时间；地图按 10 分钟层级显示半透明蓝色边界。

## 可达范围数据

- **公交 / 地铁**：使用高德地图 JS API 的 `AMap.ArrivalRange` 官方到达圈多边形，默认公交与地铁组合。该能力按时长查询，不支持指定某天某时刻；当前界面限 45 分钟。
- **骑行 / 驾车**：使用 Valhalla 根据 OpenStreetMap 路网生成 GeoJSON 等时圈多边形，驾车使用 `auto`，骑行使用 `bicycle`。边界由道路网络计算，不绘制方格；通行速度是路网模型值，不代表实时交通。
- **地图底图**：使用高德地图 JS API 标准底图。高德 JS API 当前没有单独的公交专用地理底图样式；地图保留默认道路、兴趣点与公交 / 地铁站点标注，通勤边界作为半透明覆盖层绘制。
- 面积根据最外层多边形计算，仅用于概览。Valhalla 公共演示服务遵循公平使用限制，服务繁忙或限流时可以稍后重试；公开应用请求带有 `X-Client-Id` 标识。

## 高德 Key

按站点所有者要求，Web 服务 Key、Web 端 JS API Key 和 JS API 安全密钥均由前端直接使用。它们会出现在公开仓库源代码及浏览器请求中。请在高德控制台绑定 GitHub Pages 域名并监控额度；如果不再希望公开，须在高德控制台轮换这些凭据后再改为服务端代理。

- [高德 JS API Key 准备](https://lbs.amap.com/api/javascript-api-v2/prerequisites)
- [高德 JS API 安全密钥](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [高德公交到达圈参考](https://lbs.amap.com/api/javascript-api/reference/route-search)
- [Valhalla 等时圈 API](https://valhalla.github.io/valhalla/api/isochrone/)
- [Valhalla 演示服务说明](https://github.com/valhalla/valhalla)

## 本地预览

在仓库根目录运行任意静态 HTTP 服务，例如：

~~~sh
python -m http.server 8000
~~~

打开 `http://127.0.0.1:8000/`。GitHub Pages 使用 `main` 分支根目录，推送后会自动发布。