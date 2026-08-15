# Navi 静态快捷导航

这是一个可以托管到 GitHub Pages 的快捷导航页。页面使用 `HTML + CSS + JavaScript + JSON`，不需要 Go、数据库或常驻服务器。

## 数据同步方式

`shortcuts.json` 是公共数据源。GitHub Pages 本身不能直接写回仓库，因此页面提供两种方式：

- 配置 GitHub Token 后，添加、编辑、删除和排序会自动通过 GitHub Contents API 提交 `shortcuts.json`。
- 仓库中的 GitHub Actions 会在 `shortcuts.json` 更新后，从网站服务器侧抓取图标并保存到 `icons/`，页面优先读取这些托管图标。
- 没有配置 Token 时，修改只保存在当前浏览器，也可以使用“导出”下载 JSON 后手动提交。

适合个人在 PC、手机和平板之间同步使用。其他设备打开页面或刷新后，会从 GitHub 读取最新的 `shortcuts.json`。

## GitHub 自动同步配置

1. 在 GitHub 创建 Fine-grained personal access token。
2. `Repository access` 只选择这个导航仓库。
3. `Repository permissions → Contents` 设置为 `Read and write`。
4. 打开网站，点击右上角 `GitHub`。
5. 填写用户名、仓库名、分支和文件路径，粘贴 Token，点击“保存并读取”。

在 `renlu99.github.io/navi/` 这类 GitHub Pages 地址中，用户名和仓库名会自动填充。Token 只保存到当前设备浏览器的 `localStorage`，不会写入项目文件；可以在弹窗中点击“清除 Token”。建议设置有效期，不要使用全局权限 Token。

GitHub Contents API 要求更新文件时携带文件当前的 `sha`，页面会自动读取最新版本并提交更新。相关权限参考 [GitHub 官方文档](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。

首次使用时，请在仓库的 `Settings → Actions → General` 确认允许 Actions 写入仓库内容（工作流已声明 `Contents: Read and write`）。添加或编辑快捷方式后，`Fetch shortcut icons` 工作流会自动运行；图标抓取失败时，页面仍会回退到网站原始图标或文字首字母。

## 文件说明

```text
index.html       页面结构和 GitHub 设置弹窗
style.css        页面样式
app.js           页面交互和 GitHub 同步逻辑
shortcuts.json   快捷方式数据
scripts/fetch_icons.py
                  GitHub Actions 使用的图标抓取脚本
.github/workflows/fetch-icons.yml
                  图标自动抓取工作流
```

## 本地预览

不要直接双击 `index.html`，浏览器通常会阻止 `file://` 页面读取 JSON。可以使用任意静态文件服务器，例如：

```bash
python -m http.server 8000
```

然后打开 <http://localhost:8000>。

## 发布到 GitHub Pages

1. 将项目文件推送到 GitHub 仓库的 `main` 分支。
2. 进入仓库的 `Settings → Pages`。
3. 在 `Build and deployment` 中选择 `Deploy from a branch`。
4. 选择 `main` 和 `/ (root)`，保存。
5. 等待 GitHub Pages 发布完成。

项目没有构建步骤，也不需要配置 Node、Go 或数据库。

## 手动更新数据

点击“导出”会下载当前数据为 `shortcuts.json`。也可以直接编辑仓库内的 JSON 文件，然后提交：

```bash
git add shortcuts.json
git commit -m "更新快捷方式"
git push
```

数据格式示例：

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
