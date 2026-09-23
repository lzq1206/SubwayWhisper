# SubwayWhisper · 城市通勤圈

基于 GitHub Pages 的交互式通勤等时圈地图。首次打开时按设备 IP 获取所在城市级位置并设置一个可调整的近似起点；也可以点击地图或使用右下角定位按钮调整起点。地图按所选出行方式显示半透明边界；底部控制区把出行方式与地图叠加选择器并排显示，整个控制区可收起。通勤时间与计算按钮固定在底部；计算结果和数据来源收纳在“显示更多内容”中。

## 可达范围数据

- **公交 / 地铁**：使用高德地图 JS API 的 `AMap.ArrivalRange` 官方到达圈多边形，默认公交与地铁组合。该能力按时长查询，不支持指定某天某时刻；当前界面限 45 分钟。
- **时间选择**：使用拖动条。公交 / 地铁为 10–45 分钟、每 5 分钟一步；骑行 / 驾车为 10–60 分钟、每 10 分钟一步。界面不提供公共路网服务暂不支持的 60 分钟以上范围。
- **骑行 / 驾车**：使用 Valhalla 根据 OpenStreetMap 路网生成 GeoJSON 等时圈多边形，驾车使用 `auto`，骑行使用 `bicycle`。目前公共服务将等时圈限制在 60 分钟；不会用估算边界替代路网结果。
- **地图底图**：使用高德地图 JS API 标准底图。高德 JS API 当前没有单独的公交专用地理底图样式；地图保留默认道路、兴趣点与公交 / 地铁站点标注，通勤边界作为半透明覆盖层绘制。
- 面积根据最外层多边形计算，仅用于概览。可覆盖人口按同一最外层边界统计 WorldPop 2020 年 100 米总人口栅格像元值并取整显示，是模型估算而非实时人口。Valhalla 公共演示服务遵循公平使用限制，服务繁忙或限流时可以稍后重试；公开应用请求带有 `X-Client-Id` 标识。
- **IP 初始位置**：高德 `AMap.CitySearch` 按 IP 返回城市与城市范围；初始标记采用返回范围中心，只是城市级近似点，不等同设备 GPS 定位。点击地图或使用右下角定位按钮可修正出发点。
- **高德热力图**：默认关闭；使用 `AMap.Heatmap` 绘制公园 POI 分布，不代表实时人流或拥堵。缩放或移动结束 600 毫秒后，通过 `PlaceSearch.searchInBounds` 查询当前地图视野；分四个区域，每区最多返回 50 个点，共最多 200 个并去重；单个区域查询失败时保留其他区域结果，减少高密度视野翻页失败。大范围视野为采样展示，非完整统计。
- **人口地图**：默认关闭；按需加载 WorldPop 100 米人口密度 ImageServer 影像图层，显示 2000–2020 年数据中的 2020 年全球估算。地图按固定阈值（0、10、50、150、500、2,000、10,000、20,000、30,000、40,000、50,000 人/平方公里）将密度重分类为浅蓝到浅红的颜色梯度；整体图层透明度降低以保留底图细节，50,000 及以上使用最深档，分级图例显示在底部控制卡片上方，手机端居中、桌面端右对齐。栅格按地图瓦片范围实时请求；下拉菜单每次只启用一种叠加图层。
- **全国重点文保单位**：默认关闭；开启后按 [CulturalWhisper](https://github.com/lzq1206/CulturalWhisper) 的显示规则绘制 5,066 个点位：颜色从红到蓝对应第一批至第八批，圆形、方形、菱形、三角形和六边形对应文物类别；放大至城市级且可见点位不拥挤时显示名称。数据依据 [国家文物局全国重点文物保护单位名单](https://gl.ncha.gov.cn/#/public-service)，覆盖 1961–2019 年公布批次。数据文件按需加载，坐标在前端转换为高德地图使用的 GCJ-02 坐标。
- **地图叠加**：底部控制区中的下拉菜单可选择不显示叠加、高德热力图、WorldPop 人口地图或全国重点文保单位；同一时间只显示一种叠加。出行方式按钮与叠加选择器并排，底部控制区整体可展开或收起；通勤结果行显示“交通等时圈每10分钟一个色彩梯度”提示，计算结果及数据来源默认折叠。

## 高德 Key

Web 端 JS API Key 和 JS API 安全密钥由前端直接使用，会出现在公开仓库源代码及浏览器请求中。请在高德控制台绑定 GitHub Pages 域名并监控额度；如果不再希望公开，须在高德控制台轮换这些凭据后再改为服务端代理。

- [高德 JS API Key 准备](https://lbs.amap.com/api/javascript-api-v2/prerequisites)
- [高德 JS API 安全密钥](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [高德自有数据热力图示例](https://lbs.amap.com/demo/javascript-api/example/selflayer/heatmap)
- [高德 PlaceSearch 参考](https://lbs.amap.com/api/maps-javascript-api/reference/search/placesearch)
- [WorldPop 100 米人口密度数据服务](https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Population_Density_100m/ImageServer)
- [WorldPop 100 米总人口数据服务](https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Total_Population_100m/ImageServer)
- [WorldPop 全球人口数据说明](https://hub.worldpop.org/)
- [高德公交到达圈参考](https://lbs.amap.com/api/javascript-api/reference/route-search)
- [Valhalla 等时圈 API](https://valhalla.github.io/valhalla/api/isochrone/)
- [Valhalla 演示服务说明](https://github.com/valhalla/valhalla)

## 本地预览

在仓库根目录运行任意静态 HTTP 服务，例如：

~~~sh
python -m http.server 8000
~~~

打开 `http://127.0.0.1:8000/`。GitHub Pages 使用 `main` 分支根目录，推送后会自动发布。
