# SubwayWhisper · 城市通勤圈

一个中文地图网页，搜索或点选出发地，再选择公交 / 地铁、骑行或驾车，以及 10–60 分钟的时间上限。页面通过 Cloudflare Worker 调用高德 Web 服务路线规划接口，按每个网格中心返回的路线耗时着色。

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

地点搜索和路线范围还需要已经部署的 Cloudflare Worker API 与 AMAP_WEB_KEY 加密变量。

## Cloudflare Worker 部署

`worker.js` 将 `/api/health`、`/api/search` 和 `/api/isochrone` 分发到 `functions/api/` 中的处理器。`wrangler.toml` 将 Cloudflare Worker 入口设为 `worker.js`，Worker 名称需与 Cloudflare 控制台中的 `subwaywhisper` 一致。

1. 在 Cloudflare Dashboard 打开 `subwaywhisper` Worker，**Settings → Build** 确认 Git 仓库是 `lzq1206/SubwayWhisper`、生产分支是 `main`、部署命令为 `npx wrangler deploy`。
2. 在 Worker 的 **Settings → Variables & Secrets → Add** 添加名为 `AMAP_WEB_KEY` 的加密 Secret，值从本地 `gaode.txt` 文件复制。不要把 Key 写进 `app.js`、仓库变量文件或 GitHub Pages 产物。
3. 保存后重新部署。Worker 的 `workers.dev` 地址可在 Overview 中查看；如果前端使用 GitHub Pages，请把 `app.js` 顶部的备用 API 地址改成该 Worker 地址加 `/api`。如果页面本身由此 Worker 域名打开，前端会自动使用同域 `/api`。
4. GitHub Pages 已从 `main` 根目录发布。向 `main` 推送会分别触发 GitHub Pages 和 Cloudflare Workers Builds。

## 路线服务

网页中的高德 Key 仅由 Cloudflare Worker 读取。服务仅开放地点搜索和固定参数的范围计算，并限制来源、单次路线点数和查询频率。公交路线按所选出发时刻规划。提交搜索词、出发点与网格目的地点时，坐标和路线查询会发送到高德。
