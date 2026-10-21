# PHP 8.3 Beta 升级

## 范围

- Docker 运行时从 `php:8.1-fpm-alpine` 升级为 `php:8.3-fpm-alpine`，保持现有 Nginx、PHP-FPM、扩展和数据目录布局。
- 保留 `8.3` 浮动标签以接收 8.3 系列补丁。部署构建必须使用 `--pull`，否则可能继续使用本地旧基础镜像。
- 修复容器停止信号不匹配：PHP-FPM 基础镜像默认 `SIGQUIT`，现有启动脚本原本只处理 `SIGTERM`/`SIGINT`，实测停止超时后被强杀。现在显式使用 `SIGTERM`，并兼容处理 `SIGQUIT`，转发给 Nginx/FPM 后等待退出。
- 分支：`beta/php-8.3`。Beta 推送只运行回归测试；现有正式部署仅监听 `main`，镜像发布仅监听版本标签或手动触发。
- 不修改业务逻辑、数据库结构和依赖版本。当前 fork 隐藏公开评论界面的行为保持不变。

## 安全补丁状态（2026-10-21）

[PHP 官方公告](https://www.php.net/)计划于 2026-10-21 14:00 UTC（新加坡/北京时间 22:00）发布严重漏洞修复。公告表示受影响版本和修复版本将在发布时公布。

当前验证用的 PHP 8.3.35 是升级兼容性基线，**不能据此认定已修复本次漏洞**。保持 Beta，等待公告确认修复版本及 Docker 官方镜像更新，再重新构建和测试。此分支不自动部署、不发布正式版本。

## 可重复测试

需要 Python 3.11+，无第三方 Python 依赖。

本地 PHP 8.3（启用 `gd`、`mbstring`、`pdo_sqlite`、`zip`、`dom`、`fileinfo`、`openssl`、`zlib`）：

```sh
python tests/run.py --php /path/to/php
```

完整 Docker 环境（Nginx + PHP-FPM）：

```sh
docker build --pull --no-cache -f php-site/Dockerfile -t siyuan-share:php83-test .
python3 tests/run.py --docker siyuan-share:php83-test
```

测试复制应用到临时目录，替换本地配置，使用全新的数据库和上传目录。Docker 模式使用临时容器及独立匿名卷，结束后删除测试容器和卷；不挂载部署数据。测试关闭真实邮件发送，使用 `E_ALL`，PHP warning/deprecation/fatal diagnostics 会导致失败。

覆盖：所有 PHP 文件语法、扩展、SQLite 初始化及重复迁移、Markdown/中文/HTML 清理、GD 图片、ZIP/gzip、PHPMailer 邮件生成；注册登录、CSRF、会话、改密退出、API Key/权限、分享创建更新删除、快照、笔记本搜索、密码/到期/访客限制、附件与分块上传、增量同步、评论接口与举报、管理员页面与设置、验证码。Docker 额外检查敏感文件拦截、静态文件、健康检查、优雅停机和重启后的数据库持久化。

测试不覆盖真实 SMTP 投递、浏览器内 JavaScript 交互、真实思源客户端、所有 NAS 架构或生产数据的每一种历史状态。自动化回归通过不等于保证不存在任何 bug。

## 官方补丁发布后

1. 在 [PHP 官方公告](https://www.php.net/)及 [PHP 8 Changelog](https://www.php.net/ChangeLog-8.php)确认修复版本和适用范围。
2. 在 Beta 分支重新运行完整 Docker 构建及回归测试。检查镜像实际版本：

   ```sh
   docker run --rm --entrypoint php siyuan-share:php83-test -v
   docker image inspect siyuan-share:php83-test --format '{{.Id}}'
   ```

3. 只有镜像内 PHP 达到官方修复版本且所有检查通过，才安排合并和正式部署。先一致性备份 SQLite、uploads 和配置，保留旧镜像用于回退；本次任务不操作生产服务。
4. 正式源码部署时先 `docker compose build --pull` 再 `docker compose up -d`，核对运行中的 PHP 版本与健康状态。仅重新启动旧容器不会安装补丁。

## 验证记录

- 2026-10-21，本地官方 Windows PHP 8.3.35 NTS x64：38 项运行时检查通过；15 组功能测试中 14 组通过、1 组 Nginx 专项留给 Docker 环境验证；无 PHP warning/deprecation/fatal diagnostics。
- Docker 完整回归由 `.github/workflows/php83-regression.yml` 执行，记录实际容器 PHP 版本和测试结果；应以 Beta 分支 Actions 运行结果为准。
