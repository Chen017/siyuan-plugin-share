# 工程维护指南

本文面向开发者及后续维护本项目的 AI Agent。用户安装、配置和手动备份步骤以根目录 README 为准；PDF 行为详见 [PDF 文档](GUEST_PDF_EXPORT.md)，上传和迁移约束详见 [上传保护](UPLOAD_SAFETY.md)，界面决策详见 [界面记录](UI_REFINEMENT.md)。修改实现时同步检查这些文档。不要把历史兼容或保护代码当作无用代码直接删除。

## 结构与边界

- `index.js`、`index.css`、`plugin.json`、`i18n/` 是思源插件，不需要构建；它通过 API 将分享和资源同步到固定的 `https://note.etalib.space`。插件的 `resources/controls.*` 打包时取自服务器的同名文件，修改后应验证两端。用户在界面设置 API key，不能切换或修改站点地址。
- `php-site/index.php` 是服务端入口和路由；`database.php`、`legacy-cleanup.php` 管理 SQLite 初始化与迁移；`sync.php`、`storage.php`、`upload-safety.php` 处理同步与文件生命周期。`share-access.php`、`share-assets.php`、`reader.php` 负责访问、附件和阅读器；`admin*.php` 是后台；`pdf-*.php` 与 `assets/pdf-*` 实现 PDF 访问与生成。
- `php-site/assets/` 是阅读器 CSS/JS；`assets/vendor/` 和 `php-site/vendor/` 是随项目分发的依赖，不能只按文件名判断未使用。字体来源和 PDF 依赖的许可、版本在相应目录记录。`resources/fonts/` 是字体生成输入，不是部署数据。
- `scripts/package.py` 生成插件和服务器 ZIP；服务器 ZIP 不含实例配置和运行数据。`scripts/prepare-config.sh`、`backup-data.sh`、`data-snapshot.php` 和根目录 `backup-volumes.sh` 用于配置、备份与校验。Docker 镜像会压缩自有前端资源；服务器 ZIP 保留源码资源。
- `tests/` 使用临时数据，`.test-output/` 是本地输出并被 Git 忽略。`php-site/storage/`、`php-site/uploads/` 是持久数据，不应作为清理遗留文件删除；`php-site/config.php` 是实例配置，更新时保留。

### GitHub 管理员登录

GitHub OAuth 使用服务端私有 JSON 文件 `/run/siyuan-share/github-oauth.json`，该文件必须从仓库和 Docker 构建目录之外只读挂载，且只允许 PHP worker 读取。JSON 字段为 `client_id`、`client_secret`、`callback_url`、`github_user_id` 和现有管理员的 `local_user_id`；后两者均为数字 ID。回调 URL 必须使用 HTTPS，路径为 `/auth/github/callback`。Client Secret、access token、OAuth code 均不能提交、写入镜像或打印到日志；外层反向代理也必须关闭回调路径的访问日志。注册 GitHub OAuth App 时不要启用回调通配符，不需要请求 repository scope。

私有文件挂载并重启容器后，登录页先同时提供 GitHub 和密码登录。确认绑定的 GitHub 账号能登录既有管理员后，才将 SQLite `settings` 的 `admin_auth_mode` 设为 `github`；这会拒绝所有密码登录及密码会话，GitHub 会话仍有效。设置为 GitHub 后，即使私有文件丢失或格式错误也不会恢复密码登录；应从私有备份恢复配置。GitHub 会话在管理员被禁用、身份配置或 Secret 改变时失效；旧分享密码和插件 API key 不受此开关影响。应用没有长期保存 GitHub access token。修改前备份数据库、上传文件和私有配置，并验证恢复方式；不要把私有配置放进公开备份或构建产物。

本地 OAuth 测试使用隔离的 GitHub 响应夹具：`python tests/github-auth.py --php /path/to/php`。生产启用前还须通过真实 GitHub 验证授权、反向代理日志和登录。需要恢复密码登录时，由服务器操作者离线备份后，将 `admin_auth_mode` 改为 `password`，再重启应用并检查；这会重新允许旧密码，只有在明确需要恢复时才执行。

图片尺寸由 `exportDocMarkdown` 请求思源的 `imgTag` 导出：思源 3.3.0 起可将图片节点的尺寸放进 HTML `style`。服务端 Parsedown 和浏览器 Markdown 渲染都须保留正常尺寸，同时继续清理危险属性；附件路径仍须经过既有收集与重写。已有分享只有重新同步后才能获取以前未导出的尺寸，旧版思源可能只返回普通 Markdown 图片。阅读器优先使用显式宽高，并限制图片不超过容器；无尺寸图片保留原有展示规则，图片查看器仍使用原图。

笔记本第一层中有子文档的节点按显示顺序循环使用 12 种低饱和配色，子树分支线、节点以及选中、按下和聚焦状态使用相应颜色；课程分组本身没有背景色。分组标题在各自范围内吸顶，第二层有子文档的节点在课程标题下方吸顶；无子文档的节点和文档分享不启用分组样式。颜色由顺序决定，插入或调整前面的分组会改变后续颜色。`tests/tree-groups.cjs` 覆盖配色、两级吸顶、点击与选中状态。

插件升级后，每个已有分享首次同步会重新导出全部范围内文档，再按远端快照计算增量，避免仅按更新时间跳过旧图片尺寸。附件读取失败时，增量同步保留所有已有线上附件并提示用户；非增量更新已有分享仍停止提交，以免误删。成功更新后只重试有缺失附件的文档，取消、上传失败或不支持 `imgTag` 的内核不会提前标记迁移完成。阅读器对加载失败的普通图片显示低调提示，不影响其他图片的查看器。

同时指定数值或像素宽高时，阅读器保留这两个值表达的比例并在窄容器中等比缩放；百分比、`em`、`calc()`、仅设高度或带特殊 `min-width` / `max-width` 的自定义 HTML 不作相同转换，其窄屏效果需要单独检查。思源常见的像素宽度导出不依赖此转换。

深色主题为普通 SVG 图片及查看器提供浅色底，浅色主题的 SVG 查看器和两种主题的 SVG 缩略图使用白底；不改写 SVG 颜色或文件，也不作用于表情；透明底白色线条的 SVG 可能需要单独调整。`tests/image-sizing.cjs` 覆盖主题、尺寸和查看器。

## 开发、测试与构建

需要 Git、Python 3.11、Node.js 24、PHP 8.3（含 PDO SQLite 等扩展）；容器测试另需 Docker Engine/Compose。DOM 与 PDF 验证依赖隔离安装，不要求在仓库根目录增加 Node 应用：

```sh
mkdir -p .test-output/reader-test .test-output/pdf-selection
npm install --prefix "$PWD/.test-output/reader-test" --no-save --ignore-scripts jsdom@27.4.0 jspdf@4.0.0
python -m pip install pypdfium2==5.14.0
export NODE_PATH="$PWD/.test-output/reader-test/node_modules"
python tests/run.py --php /path/to/php-8.3
for test in plugin frontend reader-ui pdf-ui controls footnotes; do node "tests/$test.cjs"; done
node tests/pdf-text-layer.cjs .test-output/pdf-selection
python tests/pdf-text-layer.py .test-output/pdf-selection
python tests/package.py
python tests/release-tag.py
python tests/plugin-release-plan.py
node tests/release-workflow.cjs
python tests/docs.py
python tests/browser-ui.py --browser /path/to/chromium
NODE_PATH="$PWD/.test-output/reader-test/node_modules" node tests/render-security.cjs
```

在 Python 虚拟环境中安装 PDFium 可避免更改全局环境；在 Windows PowerShell 设置 `NODE_PATH` 使用 `$env:NODE_PATH = '<绝对路径>'`。PHP CLI 测试需要可用的本机回环端口。若 Windows 临时路径含 `#!` 导致 PHP 配置解析失败，可将 `TEMP` 和 `TMP` 指向项目内普通路径，再重新运行。未提供 `--browser` 时，真实 PDF 浏览器下载测试会跳过；按 README 指定 Playwright 和浏览器后加 `--browser`。`--php` 不验证 Nginx；真实容器检查如下：

设置 `SIYUAN_CHROMIUM_EXECUTABLE` 为 Chromium 可执行文件路径后运行 PHP 回归，可额外使用真实浏览器验证实际 SVG 附件的图片展示和直接打开时的脚本隔离。`tests/browser-ui.py` 不传 `--svg-url` 时检查六级标题、320px 宽度和 PDF 样式；无需 Playwright。PHP runner 可用 `--test test_方法名` 只运行指定用例，参数可以重复；交付前仍应运行完整回归。

图片尺寸的真实浏览器回归使用隔离安装的 Playwright：设置 `NODE_PATH` 指向其 `node_modules`，并设置 `SPS_TEST_BROWSER` 指向 Chromium 后运行 `node tests/image-sizing.cjs`。它验证明确指定的宽高在桌面和窄容器中保持比例；DOM 和 PHP 相关检查还在 `tests/frontend.cjs`、`tests/plugin.cjs`、`tests/runtime.php` 与 `tests/run.py` 中。

使用 `python tests/browser-ui.py --browser /path/to/chromium --mermaid` 可用真实浏览器检查流程图、时序图、甘特图和类图；测试使用本地捆绑文件，不发送图表源码到网络。

```sh
docker build --pull --no-cache -f php-site/Dockerfile -t siyuan-share:php83-test .
python tests/run.py --docker siyuan-share:php83-test
bash -n scripts/*.sh backup-volumes.sh tests/backup-fixture.sh
python tests/deploy-guard.py
bash tests/backup-fixture.sh siyuan-share:php83-test
python scripts/package.py --output .test-output/package --version test
```

容器测试检查 Nginx/FPM、权限、健康状态和重启；备份夹具使用一次性数据。`tests/package.py` 检查 ZIP 完整性、PHP 包含关系、权限和隐私边界；仅打包成功不代表真实浏览器或思源客户端集成已经验证。图表、PDF、布局或客户端生命周期变化应运行对应专项及必要的真实浏览器/思源验证。

## CI、部署与发布

| 工作流 | 触发和职责 |
| --- | --- |
| `php83-regression.yml` | PR、手动或被调用。无缓存拉取并构建 PHP 镜像，验证打包、文档链接、发布标签、API、Nginx、SVG 和 PDF 真实浏览器预览及下载、备份及部署保护。 |
| `frontend-regression.yml` | PR、手动或被调用。检查语法与清单，运行插件和阅读器 DOM 回归、Markdown/Mermaid 异常输入、Chromium 标题与图表检查、PDFium 文字层检查及模拟发布；缓存 npm/pip 下载，不缓存测试结果。 |
| `deploy.yml` | `main` push 或手动触发；两套可复用回归通过后 SSH 部署。远端必须处于干净的 main，且远端 origin/main 必须等于通过测试的提交，否则拒绝部署。部署成功后比较最新正式 Release；插件有功能变更时调用发布工作流，不重复测试同一提交。 |
| `github-release.yml` | 手动触发或由部署工作流调用。手动发布先运行两套回归；自动发布复用部署前对同一提交的测试结果。校验版本、已有 Release 和 Tag；已有 Tag 必须指向本次提交，新 Tag 在归档构建后创建，两个 ZIP 上传到草稿后才公开。 |

PR 的两套回归与合并后的部署回归分别验证 PR 提交和实际 main 提交；不要简单删除后者。普通分支推送不自动测试，需要提前验证时可手动运行两套工作流；正式部署仍会完整测试。PHP 构建保留 `--pull --no-cache`，以覆盖新拉取的基础镜像及系统包。基础 PHP 镜像已带 mbstring、PDO 和 PDO SQLite，构建时先验证扩展可用，只编译缺失的 GD 和 zip；基础镜像变化时不得直接删除验证。CSS 压缩通过 `scripts/minify-css.cjs` 调用 clean-css，与原 CLI 使用同一引擎，避免额外的文件匹配与监听依赖。CI 和 VPS 各自在不同机器构建镜像：共享镜像需要额外存储、传输和权限，当前没有为此增加复杂度。CI 下载缓存不是依赖锁文件；npm 直接依赖版本已固定，传递依赖仍可能变化。

部署需要仓库 secrets `HOST`、`PORT`、`USERNAME`、`SSH_KEY`，以及远端工作流中指定的仓库、Docker 和锁文件路径。普通部署保留已保存的 PDF 设置；手动选项才会修改对应设置。现有操作者策略不保留自动回滚镜像或持久数据备份：部署仅暂停写入并比对临时指纹、SQLite 完整性及外键。手动备份流程与保留策略见 README；生产恢复时须结合对应数据、配置和镜像，不能假设仅回退镜像可撤销迁移。

自动发布比较最新正式 Release 的 Tag 与部署提交的插件代码、清单、语言、图标、许可、打包脚本和共享 controls 文件；仅文档或服务器变更不会触发。以源码 `plugin.json` 的主、次版本为系列，在该系列已有纯数字 Tag 之后分配补丁版本，写入 ZIP 内的 `plugin.json`，不改源码清单。若缺少最新 Release/Tag、查询失败，或当前提交已有待处理 Tag，流程会停止并要求检查，避免误发或重复发布。首次自动发布要求已有可解析的正式 Release。

手动发布时选择提交及版本；版本必须是有效 Tag 和安全文件名，预发布与 latest 不可同时选，版本输入不会自动更改 `plugin.json`。产物均为 `package.zip` 和 `php-site-<version>.zip`。发布失败时先检查 Actions 日志及 Release/Tag 状态：上传失败可能留下草稿和 Tag，核实资产和目标提交后人工处理草稿，再重试；不要盲目删除或移动已有 Tag。单独手动发布不会自动部署 VPS。

## 关键历史回归与修改风险

| 背景与修复原则 | 主要回归 |
| --- | --- |
| 同步失败时 SQL 回滚不能恢复已经覆盖的附件；现用新文件代际、提交后清理和会话锁。旧上传不得覆盖较新的访问设置。 | `tests/selected_fixes.py`、`tests/admin_ui.py`、`tests/run.py`；详见上传保护。 |
| 退役模块迁移保留管理员的笔记、密钥和被引用的附件；只有管理员 API key 可同步。分享访客限制已退役，但 PDF 访客配额独立保留。该个人实例没有需要迁移的普通用户账号和分享。 | `tests/legacy-migration.php`、`tests/run.py`、`tests/pdf_cookie.py`。 |
| 跨站图标不应获得思源 API Token，认证请求不跟随重定向。 | `tests/plugin.cjs`。 |
| 单站点迁移按目标地址选择旧配置，保留该站点 ID、密钥和同步缓存；其他站点配置移除。没有匹配地址时不复用别站密钥或分享缓存。更换密钥期间的旧响应不能覆盖当前状态。 | `tests/plugin.cjs`。 |
| 全新数据库使用随机初始管理员密码，记录在 PHP 日志中（默认容器日志），只保存密码哈希；并发初始化需序列化。首次登录必须设置不同密码，才能进入其他管理页面、生成密钥或使用已有 API key。已有管理员及密钥不重置。 | `tests/runtime.php` 验证随机密码与日志及重复初始化；`tests/run.py` 验证登录、强制改密和 API 限制。 |
| SVG 等主动附件需要正常作为图片预览，同时禁止其脚本访问网站；伪装成 PNG 的 SVG 也要隔离。SQLite 日志等运行时文件不应由 Nginx 静态访问。 | `tests/run.py`，其中真实浏览器和 Nginx 检查需要各自的运行环境。 |
| 六级 Markdown 标题要保持清晰层次，阅读页的后置 CSS 不得把三级标题缩回正文大小。 | `tests/browser-ui.py` 检查阅读、窄屏和 PDF 样式。 |
| 隐私保护：图表源码不应自动发给外部渲染服务；图表加载需保留公式、Markdown 和 PDF 表现。 | `tests/frontend.cjs` 及 `tests/pdf-*.cjs`。 |
| 旧版 Markdown 的特制链接与引用、旧版 Mermaid 的异常 Gantt 日期可能卡住渲染线程；已升级修复版本，来源和哈希保存在 `php-site/assets/vendor/RENDERER_DEPENDENCIES.md`。 | `tests/render-security.cjs` 对实际库执行带超时的异常输入，真实 PDF 浏览器测试覆盖公式和 Mermaid。 |
| PDF 可见排版与可选择文字层必须对齐；生成使用隔离容器和有限并发。 | `tests/pdf-text-layer.cjs`、`tests/pdf-text-layer.py`、`tests/pdf-browser.cjs`、`tests/pdf-long.cjs`。 |
| KaTeX 大型大括号与分组括号使用单个连续轮廓，网页及导出均不能出现断缝或接头凸起；六级标题间距在阅读器和 PDF 中须保持一致。 | `tests/pdf-delimiter.cjs`、`tests/pdf-math.cjs`、`tests/heading-spacing.cjs`。升级 KaTeX 后运行 `node scripts/katex-continuous-delimiters.cjs`，如果上游结构改变，脚本会拒绝修改，需要重新审查。轮廓来自 KaTeX Size4 字形，许可见 `php-site/assets/vendor/KaTeX.LICENSE.txt`。 |
| 私有权限的源码检出不能让 Nginx 无法读取镜像内静态文件；上传必须继续经授权路由。 | Docker 构建时规范文件权限；`tests/run.py --docker` 检查容器与 Nginx。 |
| 原先已有 Tag 可指向不同提交，而 ZIP 却按当前提交生成；发布必须校验两者一致。 | `tests/release-tag.py` 使用真实轻量和注释 Tag。 |
| CI 曾在检查阅读器按钮对齐时出现间歇性失败；字体或布局变化可能发生在两次位置读取之间。浏览器测试等待字体并在同一帧读取两个按钮，仍要求实际位置和高度对齐。 | `tests/pdf-browser.cjs` 检查宽屏和窄屏布局。 |

## 排查与维护

- 测试失败：先区分依赖缺失、回环端口受限、临时目录和真正的断言失败；查看具体跳过项，不把跳过当通过。容器测试失败查看 Actions 构建和容器日志，勿连接生产数据重试。
- 部署停止：检查两套回归、远端 main 是否已变化、远端工作区是否干净、锁与健康检查；不要绕过提交一致性检查。预检失败时脚本尝试重新启动原容器；切换后的失败并不保证自动回滚。
- 发布停止：检查版本、已有 Tag 与草稿，并确认手动运行选择了正确提交；不要将其他提交生成的 ZIP 上传到已有 Tag。
- 依赖升级：先确认版本来源、许可、漏洞适用性和浏览器兼容，再运行受影响的阅读器、图表及 PDF 测试。第三方压缩文件不适合做无依据的手工修改；没有完整依赖清单或安全扫描时不要声称依赖无漏洞。
- Nginx 已明确拒绝 `storage/`，但与其他镜像层调整一样，仍需在真实容器中执行对应回归；不要只凭 PHP CLI 测试认定 Nginx 规则已验证。
- Mermaid 10.9.8 预打包文件内含 DOMPurify 3.4.2，后续版本有安全公告。部分公告需要 `IN_PLACE` 等特定使用条件，目前尚未完成对所有内嵌调用路径的适用性评估，不能宣称无风险；来源、版本和哈希见 `php-site/assets/vendor/RENDERER_DEPENDENCIES.md`。

## 公开地址与本轮 UI 验收

网站界面使用英文和 SiYuan Share 站名；读取配置时只归一化两个旧默认中文名称，其他自定义名称保留。网站翻译不改变思源插件本身的语言包或笔记内容。

公开分享地址仍使用 Site settings 的 site_base_url。部署工作流的 apply_public_url 选项是本次操作者明确选择的更新：通过 scripts/configure-public-url.php 只写入 https://note.etalib.space，保留其他设置，拒绝 HTTP、凭据、查询和 fragment。普通部署不改写地址，不信任未经配置的转发请求头。该脚本的行为测试属于 admin_ui，通过 tests/run.py 和 PHP Actions 执行。

新增 tests/pdf-ui.cjs 已接入 frontend-regression.yml；tests/ui-refinement-browser.cjs 由 PDF 浏览器用例调用，PHP Actions 的 --browser 会执行。界面修改仍需重建 reader-style.css，共享 controls.* 由现有打包器装入插件 resources；本轮没有独立复制或分叉控件实现。终验结果和实机未验证项见 UI_REFINEMENT_DELIVERY.md。

Edge 的原生 downloads-hub 可能以空 Page URL 出现在 Playwright 中。PDF 无新增应用标签页检查使用浏览器级 CDP 目标列表，只排除同上下文中真实 edge:// 或 chrome:// 内部目标；未知空白页仍计入，不能通过忽略空 URL 来规避断言。
