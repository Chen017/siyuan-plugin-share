# 分支改动与历史依据

管理员专用精简的当前范围见 [精简说明](docs/FOCUS_SIMPLIFICATION.md)。实现以 `main` 为准，`upstream` 保留作上游参考。以下内容结合历史提交、当前代码和已合并的上游 PR 核对。

## 当前分支差异

| 改动 | 历史依据 / 实现 |
| --- | --- |
| 本地字体与清爽阅读页 | [6f6d06f](https://github.com/Chen017/siyuan-plugin-share/commit/6f6d06fb3ddf0699990707e84210e6bf8ef72f92)：本地 MiSans、分享页隐藏统计与评论、私有部署默认配置。现改为 34 KB 拉丁字符 WOFF2，中文用系统字体。 |
| 思源表格单元格对齐 | [d106f8a](https://github.com/Chen017/siyuan-plugin-share/commit/d106f8a)、[564e954](https://github.com/Chen017/siyuan-plugin-share/commit/564e954)、[e254077](https://github.com/Chen017/siyuan-plugin-share/commit/e254077)：处理服务端和浏览器渲染中的对齐属性及残留文本。 |
| 静态资源更新 | [3f6ddb5](https://github.com/Chen017/siyuan-plugin-share/commit/3f6ddb5285001ecb97d29cc51f5b73e85d90c5d3)：为 app.js 增加缓存版本；本次扩展到公共样式及渲染资源。 |
| PHP 与容器维护 | [dbc17ea](https://github.com/Chen017/siyuan-plugin-share/commit/dbc17ea87fd2ab57ecb8853112e6ba0d6b6d2a9d)、[325968d](https://github.com/Chen017/siyuan-plugin-share/commit/325968d)、[b8aeb14](https://github.com/Chen017/siyuan-plugin-share/commit/b8aeb14)：升级到 PHP 8.3.36、修复优雅停机，并增加隔离回归。 |
| 私有部署与数据校验 | `127.0.0.1:8081` 回环绑定；备份、逐文件恢复校验和 SQLite 指纹脚本。日常推送 main 自动部署，日常部署不自动执行数据备份。详见 [升级验收](docs/VPS_UPGRADE_20261022.md)。 |
| 2026-10-25 阅读页优化 | 图表按需加载、单次正文渲染、保留英文 MiSans 的字体瘦身、中性深色配色，以及无障碍、SEO 与公开发现文件修复。附件权限检查沿用原实现。 |

## 已合并到上游的贡献

以下 PR 的提交者均为 Chen017，现已属于上游功能：

- [#38](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/38)：深色模式代码高亮修复，2026-02-05 合并。
- [#39](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/39)：登录、后台和公共页深色模式，2026-02-07 合并。
- [#45](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/45)：自定义 HTML head 入口，2026-02-11 合并。
- [#69](https://github.com/b8l8u8e8/siyuan-plugin-share/pull/69)：行内 KaTeX 跳过花括号中的嵌套美元符号，2026-07-12 合并。

## 维护说明

- 字体源文件保留；使用 `scripts/subset-misans.py` 重新生成拉丁字符子集。公式继续使用 KaTeX 字体。
- 管理员专用版本已完整移除统计与评论的业务、接口和专属数据，不再只是隐藏界面。
- 管理员专用版本仅保留管理员密码登录；公开注册、普通验证码和邮件系统已移除，PDF 独立验证码保留。
- 历史 Lite Mode 试验已移除，未作为当前分支功能发布。
- [PHP 升级说明](docs/PHP83_BETA.md) 保留历史测试范围；当前回归入口见 README。

## 访客 PDF 与批量导出

访客打开文档后，可在 Source 旁点击 Export PDF，在无背景模糊的同页弹窗中选择范围和文档。点击 Export即自动逐篇下载，**每篇一个独立 PDF，不合并**，无需新页面或手动预览保存。弹窗显示剩余额度与下次恢复时间。浅色、深色主题及移动端导出均使用白底。

每个服务器签发的访客 Cookie 在滚动 60 分钟内默认可导出 120 篇，后台最高可设 256 篇；共用公网 IP 的访客互不占用个人额度。不同 Cookie 的指纹完全相同时，服务器要求一次验证码，通过后使用该 Cookie 自己的额度；验证码不会重置已耗尽额度。匿名 Cookie 和指纹不等同于自然人身份。

同一个 Cookie 跨窗口、跨标签页只能同时持有一个有效导出任务，由服务端事务保证。资源保护已预设并收起在后台高级设置，原有分享权限、密码和有效期检查继续生效。

导出的 PDF 保留页面排版，并加入与正文位置对齐的 Unicode 文字层，可选择、复制和搜索正文，同时保留隐藏来源信息；图片中的文字不做 OCR。浏览器可能需要允许连续下载多个文件。更多配置、限制及测试方式见 [访客 PDF 导出说明](docs/GUEST_PDF_EXPORT.md)。
