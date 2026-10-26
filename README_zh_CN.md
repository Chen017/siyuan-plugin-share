# 🔗 思源分享

[English](README.md) · [简体中文](README_zh_CN.md)

把思源笔记中的单篇文档、文档树或整个笔记本变成网页链接，支持密码、到期时间、访客限制与增量同步。

这是 **[Chen017](https://github.com/Chen017) 维护的个人分支**，基于 [b8l8u8e8/siyuan-plugin-share](https://github.com/b8l8u8e8/siyuan-plugin-share)。分享与同步功能来自上游；本分支主要改进阅读体验、渲染细节和私有部署。

## ✨ 这个分支改了什么

| 方面 | 个人改动 |
| --- | --- |
| 运行环境 | 升级到 **PHP 8.3.36**，修复 Nginx/PHP-FPM 容器停机信号，补充运行时与接口回归。 |
| 字体 | 英文、数字和常用标点保留本地 **MiSans**，中文使用系统字体；拉丁字符 WOFF2 仅 **34 KB**，原 TTF 约 8.1 MB。 |
| 阅读界面 | 中性表面、清晰蓝色链接、圆角按压反馈和短动效，支持减少动态效果。笔记本入口提供 Browse documents 和本地 Continue reading，不重复列出文档；阅读控件使用英语，页脚保留维护者与上游署名。 |
| 主页导航 | 后台可设置阅读主页；其他分享显示 Home / Return to home，同一主页分享内的子文档、查询参数和锚点不显示。 |
| 管理员专用后台 | 导航收敛为 Notes、Site settings、Password；保留管理员登录/退出、改密、API key、分享管理与存储额度，移除公开注册及多用户管理。 |
| 模块精简 | 完整移除访问统计与日志、后台 KPI/图表、实例统计/心跳、SMTP/邮件流程、评论、举报、公告、违禁词/扫描、普通验证码、ICP/联系配置、手动分片清理与全站清空入口。保留 PDF 独立验证码及自动上传清理。 |
| 配置保留 | 网站地址/分享前缀、HTML Head、自定义 CSS/JS 的开关、输入、说明与注入继续可用；移除上游新版检查与提示，保留署名。 |
| 数据迁移 | 一次性清理退役模块数据，保留笔记、分享链接、归属、API key 与被笔记引用的附件；保留已有访客名额并重算存储占用。[范围与迁移说明](docs/FOCUS_SIMPLIFICATION.md)。 |
| 渲染修复 | 修复思源表格单元格对齐；图表库按需加载，避免整篇 Markdown 重复渲染；保留公式、脚注和图表。 |
| PDF 导出 | 弹窗内单篇或批量导出，支持正文复制、隐藏来源信息及访客额度提示。[说明](docs/GUEST_PDF_EXPORT.md)。 |
| 无障碍与 SEO | 改善链接辨识、按钮状态、目录焦点和图片下载控件，补齐主要内容区域、页面描述、robots.txt 与真实 404。 |
| 部署维护 | 默认仅监听 **`127.0.0.1:8081`**；静态资源版本化，配备自动部署、隔离回归及备份恢复校验脚本。 |

历史依据与细节见 [分支改动](CUSTOM_FEATURES.md) 和 [PHP 升级记录](docs/PHP83_BETA.md)。

## 🚀 自己部署

安装 Docker 与 Docker Compose 后：

```sh
git clone https://github.com/Chen017/siyuan-plugin-share.git
cd siyuan-plugin-share
# 按实际需要检查 php-site/config.php。
docker compose build --pull
docker compose up -d
```

服务监听 **`127.0.0.1:8081`**，通过 HTTPS 反向代理对外访问。数据库、附件和配置持久化保存在容器之外。

已移除公开注册、邮件系统与普通验证码；PDF 独立验证码保留。先完成管理员设置、生成 API Key，再把自己的服务地址和 Key 填入思源插件。

## 开始分享

1. 在思源安装 **Siyuan Share** 插件，配置自己的服务地址与 API Key。
2. 右键文档或笔记本，创建分享。
3. 按需设置密码、到期时间或访客上限，复制链接即可分享。

更新已有分享可以保留原链接；自动更新和增量同步沿用上游功能。完整操作见 [上游使用说明](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README_zh_CN.md)。

## 已回馈上游的贡献

Chen017 此前提交并被合并的改动包括：[深色模式代码高亮 #38](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/38)、[登录/后台/公共页深色模式 #39](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/39)、[自定义 HTML head #45](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/45)，以及 [KaTeX 嵌套美元符号解析 #69](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/69)。这些功能现在也属于上游。

## 维护入口

- **`main`**：本分支实际使用与部署的代码。**`upstream`**：保留的上游参考分支。
- [PHP/Docker 回归](.github/workflows/php83-regression.yml) 与 [阅读页回归](.github/workflows/frontend-regression.yml) 使用隔离测试数据。
- [备份与回退记录](docs/VPS_UPGRADE_20261022.md) · [上游更新日志](CHANGELOG.md)。
- 自动部署工作流面向维护者自己的 VPS，使用前需配置自己的 Actions secrets。

原项目由 **b8l8u8e8 及贡献者**开发，个人分支由 **Chen017** 维护。遵循 [MIT License](LICENSE)。
