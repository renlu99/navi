# Navi 静态快捷导航

这是一个可以直接托管到 GitHub Pages 的静态快捷导航页。

- 仅使用 `HTML + CSS + JavaScript + JSON`，不需要 Go、数据库或服务器。
- `shortcuts.json` 是仓库内的初始数据文件。
- 页面中的添加、编辑、删除和排序会暂存在当前浏览器的 `localStorage`。
- 点击“导出”会下载新的 `shortcuts.json`，将它覆盖仓库文件并提交后，其他设备才能看到更新。
- 网站图标由浏览器直接读取目标站点的常见 favicon 地址，加载失败时显示名称首字母。

## 文件说明

```text
index.html       页面结构
style.css        页面样式
app.js           页面交互和本地数据逻辑
shortcuts.json   快捷方式数据
```

## 本地预览

不要直接双击 `index.html`，浏览器通常会阻止 `file://` 页面读取 JSON。可以在项目目录启动一个静态文件服务器：

```bash
python -m http.server 8000
```

然后打开 <http://localhost:8000>。

## 发布到 GitHub Pages

1. 创建 GitHub 仓库，并将上述文件推送到默认分支。
2. 进入仓库的 `Settings → Pages`。
3. 在 `Build and deployment` 中选择 `Deploy from a branch`。
4. 选择默认分支和 `/ (root)`，保存。
5. 等待 GitHub Pages 发布完成后，使用页面显示的地址访问。

项目没有构建步骤，也不需要配置 Node、Go、数据库或环境变量。

## 更新快捷方式

在页面中完成编辑后点击“导出”，下载的文件名就是 `shortcuts.json`。把它替换到项目根目录，然后提交：

```bash
git add shortcuts.json
git commit -m "更新快捷方式"
git push
```

静态网站不能直接修改 GitHub 仓库，因此“导出并提交”是更新公共数据的必要步骤。浏览器本地缓存只适合临时预览和个人设备使用。

## 数据格式

```json
{
  "revision": 0,
  "updatedAt": "",
  "items": [
    {
      "id": "unique-id",
      "title": "示例网站",
      "url": "https://example.com",
      "updatedAt": "2026-08-14T00:00:00Z"
    }
  ]
}
```
