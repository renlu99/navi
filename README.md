# 个人快捷方式导航

一个轻量的个人快捷网址导航页，支持登录保护、跨设备同步、实时更新、服务器端图标缓存、浏览器本地缓存、拖拽排序以及 JSON 导入导出。

## 一、生产环境文件

生产环境只需要上传以下文件和目录：

```text
.htaccess
index.html
style.css
app.js
sw.js
manifest.webmanifest
api.php
config.php
shortcuts.json
data/
├── .htaccess
└── icons/
    └── .htaccess
```

其中：

- `config.php`：服务器端密码和会话密钥，不能公开访问。
- `shortcuts.json`：服务端快捷方式数据，必须可被 PHP 写入。
- `data/icons/`：服务器缓存的网站图标，必须可被 PHP 创建和写入。
- `api.php`：登录、同步、SSE 实时推送和图标缓存接口。
- `sw.js`：浏览器 Service Worker，负责缓存页面资源和图标。
- `.htaccess`：Apache 安全规则和目录保护。

源码仓库中的 `.git/`、`.gitignore` 不要上传到生产环境。`README.md` 仅是部署文档，可上传也可不上传；根目录 `.htaccess` 已禁止直接访问它。

## 二、服务器要求

- Apache 或 Nginx + PHP。
- PHP 8.1 或更高版本。
- PHP 可写入 `shortcuts.json` 和 `data/icons/`。
- PHP 服务器可以访问外部 HTTPS 地址，用于首次抓取网站图标。
- 推荐启用 PHP cURL；未启用时程序会尝试使用 `allow_url_fopen`。
- 网站必须使用 HTTPS，Service Worker 和安全 Cookie 才能完整工作。

## 三、部署步骤

### 1. 上传文件

将生产文件上传到站点根目录，例如 `/public_html/`。不要覆盖已有的 `config.php`、`shortcuts.json` 和 `data/icons/`，除非这是首次部署或你已经做好备份。

### 2. 修改服务器配置

编辑 `config.php`：

```php
return [
    'password' => '修改为一个较强的登录密码',
    'session_secret' => '修改为一段足够长且随机的字符串',
    'cookie_days' => 365,
];
```

注意：

- 不要保留默认密码 `请修改为你的登录密码`。
- `session_secret` 修改后，所有已登录设备都需要重新登录。
- `config.php` 只在服务器端使用，不要放进前端 JavaScript。

### 3. 设置目录权限

Linux 主机可以参考以下权限，具体用户组名称要按主机环境调整：

```bash
chmod 640 config.php
chmod 660 shortcuts.json
chmod 750 data data/icons
chmod 640 data/.htaccess data/icons/.htaccess
```

PHP 使用的 Web 用户必须能写入 `shortcuts.json` 和 `data/icons/`。

### 4. Apache 配置

项目自带 `.htaccess`，会阻止访问 `config.php`、`shortcuts.json`、`data/`、`.git/` 和 `.example` 文件。如果规则没有生效，请确认虚拟主机允许使用 `.htaccess`，例如启用 `AllowOverride All`。

### 5. Nginx 配置

Nginx 不会读取 `.htaccess`，需要在站点配置中手动禁止敏感文件：

```nginx
location ~ ^/(data|shortcuts\.json)(/|$) {
    deny all;
}

location = /config.php {
    deny all;
}

location = /api.php {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:/run/php/php8.1-fpm.sock;
    fastcgi_buffering off;
    fastcgi_read_timeout 40s;
}
```

`fastcgi_buffering off` 和较长的 `fastcgi_read_timeout` 用于保证移动端实时同步连接不会被代理层提前截断。

## 四、首次使用和验证

1. 使用 HTTPS 打开首页。
2. 添加一个快捷方式，确认能够登录并保存。
3. 在另一台设备打开页面并登录，确认快捷方式自动出现。
4. 在 PC 添加或编辑快捷方式，移动端应在约 1 秒内自动更新，不需要手动刷新。
5. 第一次加载图标时服务器会抓取并保存；之后刷新页面会优先读取手机本地缓存。
6. 删除快捷方式后，服务器会删除对应缓存图标，浏览器本地缓存也会在页面更新时清理。

## 五、升级和备份

升级前先备份：

```text
config.php
shortcuts.json
data/icons/
```

升级时通常只需要替换：

```text
index.html
style.css
app.js
sw.js
api.php
manifest.webmanifest
.htaccess
```

不要覆盖生产环境的 `config.php`、`shortcuts.json` 和 `data/icons/`。如果升级了 `sw.js`，浏览器会通过版本号自动安装新的缓存版本；用户刷新一次后即可生效。

## 六、故障排查

### 页面能打开，但无法登录

检查 `config.php` 的密码、PHP 版本、浏览器 Cookie 和 HTTPS。

### 能登录，但添加后保存失败

检查 PHP 用户是否能写入 `shortcuts.json`。

### 快捷方式能同步，但图标一直是首字母

检查 PHP 是否允许访问外网 HTTPS、PHP cURL 或 `allow_url_fopen` 是否可用、`data/icons/` 是否可写，以及 `getimagesize` 是否启用。

### 移动端不能实时更新

检查是否通过 HTTPS 访问、Nginx 是否关闭 `api.php` 的 FastCGI 缓冲、反向代理或 CDN 是否允许约 30 秒长连接，以及浏览器控制台中 Service Worker 是否注册成功。

## 七、安全建议

- 使用强密码和随机 `session_secret`。
- 不要把 `.git/`、备份文件或数据导出文件上传到网站目录。
- 定期备份 `shortcuts.json` 和 `data/icons/`。
- 如果使用 CDN，确保不会缓存 `api.php` 的登录、同步和实时接口响应。
