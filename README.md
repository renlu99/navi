# Navi 部署说明（Go + PostgreSQL）

当前版本已经改为 **Go + PostgreSQL**：

- Go 负责网页、登录、快捷方式接口和图标接口。
- 快捷方式、排序、版本号保存在 PostgreSQL。
- 网站图标缓存保存在 PostgreSQL 的 `navi_icons` 表中。
- 删除快捷方式时，数据库会通过外键级联删除对应图标缓存。
- 启动时自动创建数据表，不需要手动执行 `schema.sql`。
- 如果项目目录中存在旧版 `shortcuts.json`，数据库为空时会自动导入一次。

## 一、需要上传哪些文件

将以下文件上传到同一个目录，例如：

```text
/opt/1panel/www/sites/Navi
```

至少需要：

```text
main.go
go.mod
start.sh
index.html
style.css
app.js
```

以下文件是辅助文件：

```text
schema.sql       # 手动检查数据库结构时使用，正常启动会自动建表
shortcuts.json   # 旧版数据文件，首次迁移完成并确认数据后可以备份移走
README.md        # 部署说明
```

旧 PHP 文件 `api.php`、`config.php`、`.htaccess` 不参与 Go 运行，不要把 PHP 环境作为 Navi 的启动入口。

## 二、在 1Panel 创建 PostgreSQL 数据库

进入：

```text
1Panel → 数据库 → PostgreSQL → 创建数据库
```

建议填写：

```text
数据库名：navi_db
用户名：navi_db
密码：设置一个数据库密码
权限：本地服务器
```

创建完成后进入 PostgreSQL 的“连接信息”，记录**实际显示的地址**和端口。

例如连接信息显示：

```text
地址：1Panel-postgresql-V7UN
端口：5432
```

那么 Go 环境中的连接字符串应为：

```text
postgres://navi_db:数据库密码@1Panel-postgresql-V7UN:5432/navi_db?sslmode=disable
```

注意：

- 地址必须使用 1Panel“连接信息”显示的完整地址，不能凭空填写旧容器名。
- 不要填写 `localhost` 或 `127.0.0.1`；它们指向 Navi 容器本身，不是 PostgreSQL 容器。
- 连接字符串最后的 `navi_db` 是数据库名。数据库没有创建时会出现 `database "navi_db" does not exist`。
- 如果密码包含 `@`、`#`、`:`、`/` 或 `%`，需要先进行 URL 编码。
- Navi 和 PostgreSQL 必须能够互相解析和访问。出现 `no such host` 时，先检查容器网络和连接信息中的地址。

## 三、在 1Panel 创建 Go 运行环境

进入：

```text
1Panel → 网站 → Go 运行环境 → 创建/编辑
```

推荐填写：

| 配置项 | 填写内容 |
|---|---|
| 名称 | `Navi` |
| 应用 | `Go` |
| Go 版本 | `1.25` 或更高版本；你截图中的 `1.26` 可以使用 |
| 运行目录 | `/opt/1panel/www/sites/Navi` |
| 容器名称 | `Navi` |
| 端口 | `7885` |
| 启动命令 | `sh start.sh` |

运行目录必须就是 `main.go`、`index.html` 和 `start.sh` 所在的目录。不要把运行目录填成上一级目录，否则会导致首页 `404 page not found` 或启动脚本找不到。

## 四、填写环境变量

在“环境变量”标签中逐项添加：

```text
PORT=7885
DATABASE_URL=postgres://navi_db:数据库密码@1Panel-postgresql-V7UN:5432/navi_db?sslmode=disable
APP_PASSWORD=网站登录密码
SESSION_SECRET=随机生成的长字符串
SESSION_DAYS=7
```

环境变量说明：

| 变量名 | 是否必填 | 示例/默认值 | 作用 |
|---|---:|---|---|
| `PORT` | 否 | `7885` | Go 服务监听端口；不填写时默认 `8080`，必须与 1Panel 端口一致 |
| `DATABASE_URL` | 是 | `postgres://navi_db:密码@1Panel-postgresql-V7UN:5432/navi_db?sslmode=disable` | PostgreSQL 连接地址 |
| `APP_PASSWORD` | 是 | 自定义密码 | Navi 网页登录密码 |
| `SESSION_SECRET` | 否 | 随机长字符串 | 登录会话签名；不填写时会使用 `APP_PASSWORD`，生产环境必须单独设置 |
| `SESSION_DAYS` | 否 | `7` | 登录会话有效天数，支持 `1` 到 `3650` |

逐项说明：

- `PORT` 必须和 1Panel 端口配置一致。
- `DATABASE_URL` 是 PostgreSQL 连接地址，不是网页访问地址。
- `APP_PASSWORD` 是 Navi 登录密码，不是数据库密码。
- `SESSION_SECRET` 用于登录会话签名，建议使用至少 32 位随机字符串。
- `SESSION_DAYS` 是登录会话有效天数，支持 `1` 到 `3650`，不填写时默认为 `7` 天。
- 修改 `SESSION_DAYS` 只影响之后新登录或新签发的会话；如果要立即让所有设备重新登录，同时更换 `SESSION_SECRET`。
- 不需要填写 `STATIC_DIR`、`ICON_DIR` 或 `COOKIE_DAYS`；当前 Go 版本不读取这些变量。

## 五、为什么启动命令使用 `sh start.sh`

`start.sh` 会在 Go 容器中自动完成：

1. 检查 `DATABASE_URL` 和 `APP_PASSWORD`。
2. 执行 `go mod tidy`，自动下载 PostgreSQL 驱动并生成 `go.sum`。
3. 编译 Go 程序。
4. 启动 `site-navigation`。

因此不要在宿主机执行 `go mod tidy`。宿主机没有 Go 时出现 `go: command not found` 是正常的，Go 命令应该在 1Panel Go 容器中执行。

首次启动会自动创建以下表：

```text
navi_meta
navi_shortcuts
navi_icons
```

如果 PostgreSQL 容器刚启动还没有准备好，程序会自动重试连接，最多约 1 分钟。

## 六、启动后检查

### 1. 查看日志

正常日志应包含：

```text
site navigation listening on :7885
```

如果出现：

```text
database "navi_db" does not exist
```

说明数据库本身还没有创建，或者 `DATABASE_URL` 最后的数据库名写错。

如果出现：

```text
lookup 1Panel-postgresql-xxx on 127.0.0.11:53: no such host
```

说明 Navi 容器解析不了数据库地址。请重新复制 PostgreSQL“连接信息”中的地址，并检查两个容器是否在可互通的 Docker 网络中。

### 2. 健康检查

访问：

```text
http://服务器IP:7885/healthz
```

正常结果：

```json
{"ok":true}
```

这个接口同时检查 PostgreSQL 连接，不只是检查 Go 进程是否存在。

### 3. 打开网站

访问：

```text
http://服务器IP:7885/
```

不要访问 `/Navi` 子路径。登录后测试添加、编辑、删除和排序，确认刷新后数据仍然存在。

## 七、旧 `shortcuts.json` 数据迁移

如果目录中有旧版 `shortcuts.json`，第一次启动时程序会检查数据库：

- 数据库为空且版本号为 0：自动导入 JSON。
- 数据库已经有数据：不会覆盖数据库，也不会重复导入。
- 导入完成后，先登录网站确认快捷方式正确，再备份并移走 `shortcuts.json`。

可以在 PostgreSQL 中查看数据：

```sql
SELECT id, title, url, "position"
FROM navi_shortcuts
ORDER BY "position", id;
```

## 八、生产环境建议

部署验证完成后，推荐使用编译后的二进制运行：

```bash
go build -trimpath -ldflags="-s -w" -o site-navigation main.go
```

然后将 1Panel 启动命令改为：

```bash
./site-navigation
```

生产目录至少保留：

```text
site-navigation
index.html
style.css
app.js
```

环境变量仍然必须保留。数据库连接信息和密码不要写入代码、不要提交 Git，也不要放进前端文件。

## 九、常见问题

### `missing go.sum entry`

确认启动命令是：

```bash
sh start.sh
```

脚本会自动执行 `go mod tidy`。如果仍然报错，确认 `main.go`、`go.mod` 和 `start.sh` 来自同一套项目文件。

### 健康状态正常，但网页 404

检查 Go 环境的运行目录是否为：

```text
/opt/1panel/www/sites/Navi
```

并确认该目录中存在 `index.html`。当前程序根路径 `/` 会自动返回 `index.html`。

### 添加快捷方式时报保存失败

先访问 `/healthz`。如果健康检查失败，优先修复 PostgreSQL 连接；如果健康检查正常，再查看 Navi 日志中的具体 SQL 错误。

### 图标仍然加载失败

服务器需要能够访问目标网站的 HTTPS 图标地址。首次请求会抓取并保存到 PostgreSQL，后续从 `navi_icons` 读取。修改快捷方式网址时会清除旧图标缓存；删除快捷方式时会通过级联关系删除对应图标。

## 十、备份与恢复

### 备份 PostgreSQL

在 PostgreSQL 容器或已安装 `pg_dump` 的环境中执行：

```bash
pg_dump "$DATABASE_URL" > navi-backup.sql
```

### 恢复 PostgreSQL

```bash
psql "$DATABASE_URL" < navi-backup.sql
```

恢复前先停止 Navi，避免恢复过程中同时写入数据。`schema.sql` 只用于手动初始化或检查结构，正常启动会自动建表。

## 十一、最终配置速查

```text
运行目录：/opt/1panel/www/sites/Navi
端口：7885
启动命令：sh start.sh
Go：1.25 或更高版本
环境变量：PORT、DATABASE_URL、APP_PASSWORD、SESSION_SECRET、SESSION_DAYS
健康检查：http://服务器IP:7885/healthz
网站地址：http://服务器IP:7885/
数据库：navi_db
```
