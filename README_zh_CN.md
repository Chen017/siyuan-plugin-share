# 🔗 思源分享

[English](README.md) · [简体中文](README_zh_CN.md)

把思源笔记中的单篇文档、文档树或整个笔记本变成网页链接，支持密码、到期时间、访客限制与增量同步。

这是 **[Chen017](https://github.com/Chen017) 维护的个人分支**，基于 [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share)。分享与同步功能来自上游；本分支主要改进阅读体验、渲染细节和私有部署。保留原作者版权及 [MIT 许可证](LICENSE)。

## ✨ 这个分支改了什么

| 方面 | 个人改动 |
| --- | --- |
| 运行环境 | 升级到 **PHP 8.3.36**，修复 Nginx/PHP-FPM 容器停机信号，补充运行时与接口回归。 |
| 字体 | 英文、数字和常用标点保留本地 **MiSans**，中文使用系统字体；拉丁字符 WOFF2 仅 **34 KB**，原 TTF 约 8.1 MB。 |
| 阅读界面 | 中性表面、清晰蓝色链接、圆角按压反馈和短动效，支持减少动态效果。笔记本入口提供 Browse documents 和本地 Continue reading，不重复列出文档；阅读控件使用英语，页脚保留维护者与上游署名。 |
| UI 与动效 | Source / Preview 切换时页面位置保持稳定。鼠标短暂停留即可预览脚注，也可以固定卡片；过渡简短且遵循减少动态效果设置。后台可在同一处管理分享信息与访问规则。 |
| 主页导航 | 后台可设置阅读主页；其他分享显示 Home / Return to home，同一主页分享内的子文档、查询参数和锚点不显示。 |
| 管理员专用后台 | 精简后台导航与网站设置；可管理分享标题、链接、有效期、访客上限和密码。删除的分享可以恢复或永久删除。插件连接信息收纳在 Site settings，存储额度设置保留；移除公开注册及多用户管理。 |
| 模块精简 | 完整移除访问统计与日志、后台 KPI/图表、实例统计/心跳、SMTP/邮件流程、评论、举报、公告、违禁词/扫描、普通验证码、ICP/联系配置、手动分片清理与全站清空入口。保留 PDF 独立验证码及自动上传清理。 |
| 配置保留 | 网站地址/分享前缀、HTML Head、自定义 CSS/JS 的开关、输入、说明与注入继续可用；移除上游新版检查与提示，保留署名。 |
| 数据迁移 | 一次性清理退役模块数据，保留笔记、分享链接、归属、API key 与被笔记引用的附件；保留已有访客名额并重算存储占用。[范围与迁移说明](docs/FOCUS_SIMPLIFICATION.md)。 |
| 渲染修复 | 修复思源表格单元格对齐；图表库按需加载，避免整篇 Markdown 重复渲染；保留公式、脚注和图表。 |
| PDF 导出 | 弹窗内单篇或批量导出，支持正文复制、隐藏来源信息及访客额度提示。[说明](docs/GUEST_PDF_EXPORT.md)。 |
| 无障碍与 SEO | 改善链接辨识、按钮状态、目录焦点和图片下载控件，补齐主要内容区域、页面描述、robots.txt 与真实 404。 |
| 部署维护 | 默认仅监听 **`127.0.0.1:8081`**；静态资源版本化，配备自动部署、隔离回归及备份恢复校验脚本。 |
| 工程清理 | 按职责拆分 PHP 模块并保持路由/API 契约；清除无引用样式和函数，统一可恢复备份入口、页面级健康检查与配置权限，测试通过后再自动部署。[维护说明](docs/MAINTENANCE.md)。 |

历史依据与细节见 [分支改动](CUSTOM_FEATURES.md) 和 [PHP 升级记录](docs/PHP83_BETA.md)。

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
