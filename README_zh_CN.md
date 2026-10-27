# Siyuan Share

[English](README.md) · [简体中文](README_zh_CN.md)

通过网页分享思源笔记的文档和笔记本，支持密码、有效期、访客人数限制、增量同步和 PDF 下载。

由 [Chen017](https://github.com/Chen017/siyuan-plugin-share) 维护，基于 [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share)。保留原作者版权及 [MIT 许可证](LICENSE)。

## 最近更新

- **阅读体验：** 切换 Source / Preview 时页面位置保持稳定。鼠标悬停片刻即可预览脚注，也可以固定或关闭卡片。动效简短，并遵循减少动态效果设置。
- **分享管理：** 可在网站后台管理每项分享的标题、链接、有效期、访客上限和密码。列表展示访问与大小信息；删除的分享可以恢复，也可以永久删除。
- **网站设置：** 精简后台导航与控件布局；插件连接信息收纳在 Site settings 中，同时保留存储限制设置。

## Docker Compose 部署

需要安装 Docker Engine 和 Docker Compose，在仓库根目录执行：

```sh
git clone https://github.com/Chen017/siyuan-plugin-share.git
cd siyuan-plugin-share
# 启动前检查 php-site/config.php。
docker compose build --pull
bash scripts/prepare-config.sh siyuan-share-web:latest
docker compose up -d --no-build --pull never
docker compose ps
```

默认 Compose 从本仓库源码构建，监听 **127.0.0.1:8081**。将 HTTPS 反向代理指向该地址，保留 Host 请求头，并在后台 **Site settings** 中填写公网 HTTPS 地址。

全新安装使用 **admin / 123456** 登录后立即修改密码。后台仅供管理员使用，不提供公开注册或邮件认证。

| 宿主持久化路径 | 用途 |
| --- | --- |
| `php-site/storage/` | SQLite 数据库及上传暂存 |
| `php-site/uploads/` | 附件 |
| `php-site/config.php` | 只读挂载的实例配置 |

更新时保留上述路径，不要用示例覆盖已有配置。首次初始化后，数据库中已保存的 PDF 设置优先于配置文件默认值。

## 连接思源笔记

1. 安装 Siyuan Share 插件，填写服务器地址和后台生成的 API key。
2. 右键文档或笔记本，创建分享。
3. 按需设置密码、有效期和访客上限，复制分享链接。

更新已有分享会保留原链接。支持自动更新、增量同步、文档树、搜索、数学公式、脚注和图表渲染。

## 阅读与 PDF

后台 **Site settings** 可配置阅读首页地址、网站地址与分享前缀、存储额度、HTML Head、自定义 CSS 和 JavaScript。自定义样式建议限定到 `body.layout-share` 或 `body.layout-app`，只插入可信代码。

打开文档后点击 **Export PDF**，可选单篇、文档及子文档、整个分享或手动选择文档。每篇分别下载，正文可选择、复制和搜索。默认每个访客在滚动一小时内可导出 120 篇，管理员可调整额度；批量下载可能需要浏览器授权。[PDF 使用与限制](docs/GUEST_PDF_EXPORT.md)。

## 备份与更新

更新前先创建并验证备份：

```sh
bash backup-volumes.sh siyuan-share-web "$PWD/backups"
```

脚本短暂停止写入，保存配置、数据与回退镜像，校验解压文件哈希和 SQLite 完整性后恢复服务。妥善保存 `BACKUP_DIR` 对应目录及其 `VERIFIED` 标记。

备份保留策略：只保留最新的一份已验证备份。新备份创建并验证成功后，手动删除旧备份；新备份验证失败时，保留原有备份。当前脚本不会自动清理旧备份。

```sh
git pull --ff-only
docker compose build --pull
bash scripts/prepare-config.sh siyuan-share-web:latest
docker compose up -d --no-build --pull never
docker compose logs --tail=100 web
```

回退时一起恢复对应的已验证数据、配置和镜像。存在数据库迁移时，仅回退镜像可能无法恢复旧版本。

## 开发验证

```sh
python tests/run.py --php /path/to/php-8.3
NODE_PATH=/path/to/isolated/node_modules node tests/plugin.cjs
NODE_PATH=/path/to/isolated/node_modules node tests/frontend.cjs
NODE_PATH=/path/to/isolated/node_modules node tests/reader-ui.cjs
python tests/package.py
```

DOM 测试依赖 `jsdom@26.1.0`；PDF 文字层验证另需 `jspdf@4.0.0` 和 `pypdfium2==5.14.0`。PHP 测试加 `--browser` 可验证真实 PDF 下载；通过 `SIYUAN_PLAYWRIGHT_MODULE`、`SIYUAN_BROWSER_EXECUTABLE` 指定隔离的 Playwright 和浏览器。`--docker <已构建镜像>` 验证实际容器，测试使用合成数据。运行数据、备份和本地测试输出不进入发布包。

`main` 的 PHP/Docker 与阅读回归通过后才会自动部署到维护者 VPS。复用工作流前请配置自己的仓库 secrets。思源插件保留无需构建的单文件入口；字体生成输入位于 `resources/fonts/`，不对外提供。
