# SubwayWhisper · 城市通勤圈

一个可部署到 GitHub Pages 的中文单页地图。输入出发地点、选择公交 / 地铁、骑行或驾车，再设置 10–60 分钟的通勤时长，即可查看按 10 分钟分层着色的网格估算范围。

## 使用

打开 [SubwayWhisper](https://lzq1206.github.io/SubwayWhisper/)，搜索地标或街道、使用当前位置，或直接点击地图设置出发点。蓝色网格代表估算可达区域；越靠近出发点的网格颜色越深。

## 估算说明

此项目提供的是便于初步比较的时间范围估算，不是导航或实时等时圈服务。范围根据各出行方式的平均速度与固定的接驳 / 停车时间计算；公交 / 地铁没有使用实际班次、站点、换乘，驾车和骑行也没有使用道路网络、红绿灯、路况或坡度。实际出行时间和范围可能差异较大。

地图由 OpenStreetMap 提供；地点搜索使用 OpenStreetMap Nominatim。提交搜索时，搜索词会发送给 Nominatim；地图切片请求会发送给 OpenStreetMap。网页不保存搜索历史或精确位置。

## 本地预览

用任意静态 HTTP 文件服务器打开项目目录，例如：

```sh
python -m http.server 8000
```

然后访问 `http://localhost:8000/`。地图图块、地点搜索与定位需要网络连接；浏览器定位通常要求 HTTPS 或 localhost。

## GitHub Pages

GitHub Pages 从 `main` 分支根目录发布。更新后推送到 `main`，Pages 会自动重新发布。
