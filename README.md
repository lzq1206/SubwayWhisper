# SubwayWhisper · 城市通勤圈

一个中文地图网页，搜索或点选出发地，再选择公交 / 地铁、骑行或驾车，以及 10–60 分钟的时间上限。页面通过 Cloudflare Pages Functions 调用高德 Web 服务路线规划接口，按每个网格中心返回的路线耗时着色。

## 实际数据与网格边界

- 驾车、骑行和公交 / 地铁分别使用高德路线规划服务；公交查询包含出发日期和时间。
- 蓝色格点按高德返回的路线耗时分成 10 分钟档，不使用平均速度估算格点是否可达。
- 当前高德 Web 服务 Key 对企业智图“可达圈”接口返回权限不足，因此页面采用实际路线查询构建粗网格；单次最多查询 40 个目的地点。样本上限或较粗分辨率可能漏掉边界和不连续的可达区域，面积是已验证网格的面积总和，不是精确的连续等时圈面积。
- 地图底图由 OpenStreetMap 提供。地点搜索和路线规划由高德处理，网页不保存位置或搜索历史。

## 本地运行

任意静态 HTTP 服务都可用于预览页面。例如：

~~~sh
python -m http.server 8000
~~~

地点搜索和路线范围还需要已经部署的 Cloudflare Pages API 与 AMAP_WEB_KEY 加密变量。

## Cloudflare Pages 部署

项目使用 Cloudflare Pages 的 Git 集成，仓库根目录作为站点目录。创建或检查项目时，把 Build command 设为 `exit 0`，Build output directory 设为 `.`；`functions/api/` 会生成 `/api/*` 服务端路由，`_routes.json` 让其他静态资源继续直接由 Pages 提供。

1. 在 Cloudflare Dashboard 打开 subwaywhisper Pages 项目。
2. 进入 **Settings → Variables and Secrets → Add**，变量名填写 AMAP_WEB_KEY，把文件 gaode.txt 中的 Key 放入值栏并选 **Encrypt**。将其设在 Production 环境；如要预览分支调用 API，也可为 Preview 单独设置。
3. 保存后重新部署项目。不要将 Key 写进 app.js、仓库变量文件或 GitHub Pages 产物。
4. 正式 Pages 域名如果不是 subwaywhisper.pages.dev，请把 app.js 顶部的 API 地址 https://subwaywhisper.pages.dev/api 改成实际的 Pages 域名加 /api。
5. 确认 Production branch 是 `main` 且启用自动部署。推送到 `main` 后，GitHub Pages 和 Cloudflare Pages 都会自动更新；GitHub Pages 前端通过 Cloudflare Pages API 访问路线服务。

## 路线服务

网页中的高德 Key 仅由 Cloudflare Pages Function 读取。服务仅开放地点搜索和固定参数的范围计算，并限制来源、单次路线点数和查询频率。公交路线按所选出发时刻规划。提交搜索词、出发点与网格目的地点时，坐标和路线查询会发送到高德。
