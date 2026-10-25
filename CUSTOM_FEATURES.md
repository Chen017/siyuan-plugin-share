# Siyuan Plugin Share 分支自定义特性汇总

本文档记录了当前分支（`main`）相对于上游仓库（`upstream: b8l8u8e8/siyuan-plugin-share`）的所有自定义改动、新增特性以及配置调整。

---

## 目录
0. [访客 PDF 与批量导出](#0-访客-pdf-与批量导出)
1. [字体与样式定制（MiSans 字体）](#1-字体与样式定制misans-字体)
2. [前端分享页元素隐藏（阅读统计与评论区）](#2-前端分享页元素隐藏阅读统计与评论区)
3. [站点配置定制（config.php）](#3-站点配置定制configphp)
4. [Docker 部署与端口安全定制](#4-docker-部署与端口安全定制)
5. [CI/CD 自动化部署工作流](#5-cicd-自动化部署工作流)
6. [已合并至上游的特性：KaTeX 数学公式嵌套解析修复](#6-已合并至上游的特性katex-数学公式嵌套解析修复)
7. [关于历史“精简模式（Lite Mode）”状态说明](#7-关于历史精简模式lite-mode状态说明)

---

## 0. 访客 PDF 与批量导出

- 无须管理员登录，在授权分享页导出单篇、文档树、整个分享范围或勾选多篇，合并为按文档分页的 PDF。
- 服务端限量整理打印页面，浏览器生成 PDF；复用 KaTeX、图片、表格、代码和图表渲染。
- SQLite 原子限流同时控制 IP、浏览器指纹和并发；限制批量、内容、图片和附件预算，复核密码、有效期与访客上限。
- 管理员可在「站点设置 → 访客 PDF 导出」管理开关、全部限制及可信代理，独立保存后立即生效；PHP 配置只作为首次初始化默认值。
- 常用界面仅保留开关、统计时长和统一次数，默认 1 小时 5 次；只换 IP 或只换浏览器不能绕过已用完的额度。资源保护项已预设并默认收起在高级设置。
- 配置、限制和测试方式见 [访客 PDF 导出说明](docs/GUEST_PDF_EXPORT.md)。本功能不要求修改镜像或新增服务。

---

## 1. 字体与样式定制（MiSans 字体）

### 改动目的
- 移除对外部 Google Fonts（`Outfit`, `Noto Sans SC`, `Noto Serif SC`）的在线请求依赖，避免国内网络环境下由于字体加载缓慢导致页面排版闪烁（FOUT/FOIT）。
- 将全站字体统一为小米 **MiSans** 字体，并在正文与阅读页强制生效。

### 涉及文件与具体实现
- **引入本地字体文件**：
  - `php-site/assets/MiSans-Regular.ttf`
  - `php-site/assets/MiSansVF.ttf`
- **样式文件重构 (`php-site/assets/style.css`)**：
  - 移除原头部 `@import url("https://fonts.googleapis.com/...")` 外部字体引入。
  - 添加本地 `@font-face` 声明：
    ```css
    @font-face {
      font-family: 'misans regular';
      src: url('./MiSans-Regular.ttf') format('truetype');
    }
    ```
  - 将根变量修改为 MiSans：
    ```css
    --font-display: "misans regular", sans-serif;
    --font-body: "misans regular", sans-serif;
    --font-markdown: "misans regular", sans-serif;
    ```
  - 在正文与分享布局中强制覆盖文本节点字体：
    ```css
    body.layout-share .markdown-body :where(
      p, li, a, strong, em, del, mark,
      h1, h2, h3, h4, h5, h6,
      blockquote, td, th
    ) {
      font-family: var(--font-markdown) !important;
    }
    ```
  - 适配了深色模式 (`@media (prefers-color-scheme: dark)` 及暗黑主题) 的字体强制规则，同时保留 KaTeX 数学公式原生字体不受影响。
- **服务端 HTML 动态兜底 (`php-site/index.php`)**：
  - 在 `render_page()` 方法输出 `</head>` 之前增加判断：针对 `layout === 'share'` 动态注入 `<style id='sps-share-font-force'>`，确保即使有外部自定义 head 代码注入，MiSans 字体依然具有最高优先级。

---

## 2. 前端分享页元素隐藏（阅读统计与评论区）

### 改动目的
- 分享笔记页面需要更加纯净的阅读体验，无需展示阅读次数/发布时间统计栏，也不需要读者评论功能。

### 涉及文件与具体实现
- **备忘指引 (`php-site/Injection.md`)**：
  记录了待拦截渲染的函数名及注入代码：
  ```text
  render_share_stats
  render_share_comments

  return '';
  ```
- **核心代码拦截 (`php-site/index.php`)**：
  - **隐藏分享统计信息栏**：在函数 `render_share_stats()` 的第一行直接插入 `return '';`，拦截阅读量、创建时间、过期时间等统计卡片的生成。
  - **隐藏分享评论区**：在函数 `render_share_comments()` 的第一行直接插入 `return '';`，拦截评论列表和评论提交表单的生成。

---

## 3. 站点配置定制（config.php）

### 改动目的
- 固化生产环境基础安全策略。

### 涉及文件与具体实现
- 将模版文件 `php-site/config.example.php` 固化为直接生效的 `php-site/config.php`，并进行了如下安全调整：
  - `'allow_registration' => false`：关闭用户公开注册功能，仅允许管理员手动创建或邀请。
  - `'captcha_enabled' => false`：在私有部署/关闭注册环境下关闭图片验证码，简化使用流程。

---

## 4. Docker 部署与端口安全定制

### 改动目的
- 规范端口绑定，便于配置反向代理（如 Nginx、Caddy、1Panel），提升容器暴露在公网时的网络安全性。

### 涉及文件与具体实现
- **`docker-compose.yml`**：
  - 端口映射由 `"8080:80"` 修改为 `"127.0.0.1:8081:80"`。
  - **优势**：服务仅监听服务器本地回环地址 `127.0.0.1` 的 8081 端口，外部无法直接通过 IP+端口绕过反向代理访问，强制走反向代理的 HTTPS/防火墙策略。
- **`docker-compose.nas.yml`**：
  - 移除了冗余的 `image: siyuan-share-web:latest` 声明，统一采用本地 Dockerfile 构建。

---

## 5. CI/CD 自动化部署工作流

### 改动目的
- 恢复推送 `main` 后自动构建并更新个人 VPS 的日常流程。

### 涉及文件与具体实现
- **SSH 自动发布工作流 (`.github/workflows/deploy.yml`)**：
  - 推送 `main` 自动触发，也可以手动运行；手动入口无需选择操作。
  - 通过现有 SSH 凭据更新服务器上的 `main`，构建 PHP 8.3 镜像并更新 Web 容器，清理无标签旧镜像。
  - 检查构建和运行中的 PHP 至少为 8.3.36，并等待容器健康及登录页 HTTP 200。
  - 日常 Action 不执行数据备份、恢复演练或备份包删除，不提供相应操作选项。PHP 完整回归工作流继续保留，使用隔离测试数据。
  - 首次安全升级时的一致性备份与安装过程作为历史记录保留，详见 [VPS 升级验收记录](docs/VPS_UPGRADE_20261022.md)。
- **清理无用上游工作流**：
  - 删除了原作者用于同步到 Gitee 的工作流文件 `.github/workflows/sync-to-gitee.yml`。

---

## 6. 已合并至上游的特性：KaTeX 数学公式嵌套解析修复

### 背景与现状
- **问题**：在 markdown-it 解析行内数学公式（`$...$`）时，若公式内部包含带花括号的作用域（如 `\text{...$...$}`），括号内的 `$` 会被提前误识别为闭合符，破坏复杂数学公式的渲染。
- **本分支提交**：在提交 `a87d690` 中通过引入 `braceDepth` 计数器跳过了 `{...}` 内的 `$`。
- **已合并上游**：该修复已通过 Pull Request 提交并被上游仓库合并（上游提交 `b859a00 fix: prevent premature termination of inline KaTeX expressions`，作者：`塵 <tglchen17@gmail.com>`），并已正式包含在上游 **v0.5.5** 发行版中。
- **结论**：本项已不再属于分支特有的私有改动，后续与上游最新分支同步时可无冲突直接对齐。

---

## 7. 关于历史“精简模式（Lite Mode）”状态说明

- **历史背景**：前期分支中曾尝试开发过“精简模式”（Lite Mode），包含相关的界面开关、简化渲染和配置逻辑。
- **当前状态**：经全面检查与 Git 记录核对（提交 `7a77df7`、`8153ee2`、`0fe3bea`），该功能在后续开发中已**完全移除**，并恢复为与上游一致的标准处理逻辑。当前分支没有任何精简模式的残留代码或配置。
