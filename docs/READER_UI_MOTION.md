# 阅读界面与动效适配

本次将阅读页收敛为中性表面、蓝色强调、稳定导航和清晰标题层次。保留本地 MiSans 拉丁子集、系统中文字体、图表按需加载和单次 Markdown 渲染。

## Apple 参考与适配边界

检索日期：2026-10-26。以下均为 Apple 官方资料。

- [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)：反馈短而准确，进退方向一致，高频动作减少多余运动，允许中断。
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)：支持 Reduce Motion，减少缩放、反复运动与模糊变化。
- [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)、[Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)：操作结果、禁用与进行中状态需要清晰反馈。
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)：导航层次、展开与当前选中状态保持一致。
- [Searching](https://developer.apple.com/design/human-interface-guidelines/searching)、[Loading](https://developer.apple.com/design/human-interface-guidelines/loading)：保留阅读上下文，在真实等待时反馈状态。
- [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)、[Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers/)：浮层有明确的呈现和关闭关系，紧凑屏幕保留足够可操作空间。
- [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)、[Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/)：选中、焦点和开关状态应能区分。
- [Animate with springs, WWDC23](https://developer.apple.com/videos/play/wwdc2023/10158/)：参考自然响应和连续性。

这是一套对 HIG 原则的 Web 适配。HIG 没有规定本项目必须使用的 CSS 毫秒值或贝塞尔曲线；下面的 token 为本项目选择，不能等同于原生 SwiftUI spring 或 Liquid Glass。

当前版本的模块范围见 [管理员专用精简](FOCUS_SIMPLIFICATION.md)。下方历史验收记录保留用于追溯。

## 操作逐项映射

| 操作 | 适配方式 | 动效 / 状态 |
| --- | --- | --- |
| 普通、主要、危险按钮 | 统一圆角，保持文字位置稳定，明确禁用状态 | 90ms 按压；140ms 小区域色彩反馈 |
| 输入框和表单聚焦 | 统一焦点环，不依靠位移表达焦点 | 140ms 边框反馈 |
| 开关 | 拇指跟随开关状态 | 200ms transform |
| 后台导航、树/目录切换 | 切换立即生效，当前项有稳定强调 | 140ms 颜色反馈，无整页滑动 |
| 文档树展开 / 收起 | 箭头旋转；大分支直接更新，不逐条播放 | 200ms 箭头 transform；无 height 动画 |
| 长标题树节点 | 两行标题、收紧缩进、限制 flex 最小宽度 | 无横向 hover 位移；保留完整链接名称和 title |
| 正文目录跳转 | 保留真实 heading 焦点及锚点 | 平滑滚动；Reduce Motion 使用 auto |
| 手机导航 | 入口在正文前的工具栏；抽屉有关闭按钮、焦点循环、背景 inert | 打开 280ms、关闭 180ms；transform + opacity |
| 笔记本入口 | 名称、说明、展开文档树按钮与有效的继续阅读入口；不列出课程或子文档 | 初始内容直接可见 |
| 继续阅读 | 按分享 slug 隔离，校验文档仍存在和记录时效 | 明确点击后恢复位置，不自动打断首次访问 |
| 文档切换 | 保留导航，取消旧请求；只在成功后确认当前文档并移动标题焦点 | 正文立即显示；250ms 后才播报加载状态 |
| 搜索 | 300ms 防抖、取消旧请求、清空立即失效；上下键选择、回车打开、Esc 清空、Ctrl/Cmd+K 聚焦 | 200ms 后显示等待；默认在当前阅读区打开 |
| 搜索摘要 | 简化 Markdown 和公式标记；不为结果列表引入公式渲染依赖 | 纯文本结果与关键词高亮 |
| 源码 / 预览 | 原生切换按钮与 aria-pressed | 立即切换，不动画排版高度 |
| 代码复制 | 复制结果同时更新 tooltip、标签和状态提示 | 1500ms 后恢复标签；不增加循环动画 |
| 脚注浮窗 | 展示短位移；关闭共用可中断生命周期 | 200ms 进入、180ms 退出；拖动/缩放直接响应 |
| 图片查看器 | 工具栏短反馈；拖拽、捏合、缩放和旋转保持直接控制 | 无额外插值拖慢手势；180ms 关闭淡出；移除工具栏背景模糊 |
| PDF 弹窗 | 与其他浮层统一方向，额度摘要优先，恢复规则折叠 | 280ms 进入、180ms 退出；移除全屏模糊与 iframe 高度过渡 |
| Toast | 短进入反馈和退出反馈 | 200ms 进入、180ms 退出 |
| 回到顶部 | 明确的普通控件，保留淡入和状态 | 滚动尊重 Reduce Motion |
| 登录吉祥物 | 保留输入焦点关联动作，遮眼改为 transform | 停止呼吸/眨眼循环，不动画 top/left/right |
| 错误页 | 保留静态插画及返回入口 | 停止无休止浮动、闪烁、轨道和涟漪 |
| 原生下拉、浏览器 confirm、下载选择器 | 继续交给浏览器/操作系统 | 不覆盖原生行为，不伪造系统动效 |

## 阅读记录

`localStorage` 中每个分享保存一条最近阅读记录：文档 ID、标题、纵向位置和时间戳；不保存正文或账号信息。离开文档、页面隐藏或关闭时更新，无逐帧存储操作。入口只为当前分享仍可访问、30 天内的记录展示“继续阅读”。浏览器禁用存储时静默降级。链接仍需通过服务端现有权限检查。

## 阅读界面细节修复

- 笔记本欢迎页仅提供 Browse documents 和有有效本地记录时的 Continue reading；正文页面不插入子文档列表。文档可同时承载正文和子文档，统一通过侧栏文档树访问。
- 欢迎页采用适度留白、简短引导和本地阅读记录说明，不用重复文档列表填充空间。
- 阅读区、侧栏与页脚共用圆角外框，由同一底层绘制侧栏底色。移除侧栏的大面积阴影延伸，避免页底与滚动边界出现色块拼接。
- 前台禁用浏览器原生矩形点击高亮，使用控件自身圆角内的按压状态；保留键盘焦点环及正文链接下划线。
- 阅读、搜索、源码、图片查看器、脚注和 PDF 导出的操作文字统一为英语；保留笔记标题、正文及 PDF 作者版权信息。

## 性能与可访问性约束

- 新样式合并进已有 `style.css`，不增加 CSS 请求，不引入动画库或字体。
- 主要空间动效使用 transform / opacity；阅读正文首屏不等待动画。
- 不对长篇正文整体做进出场图层；不为整棵树播放逐项动画。
- 不默认使用 will-change；避免长期额外图层。
- Reduce Motion 覆盖 CSS 动画、过渡及 JS 平滑滚动；关闭浮层立即完成。
- 手机抽屉关闭时不可聚焦，打开时约束焦点，关闭后返回触发控件。
- 大幅调整宽度的公式、表格和图表保留原有溢出处理；PDF 阅读正文的字号与排版规则保持隔离。

## 验证

- `tests/frontend.cjs`：公式、中文目录焦点、导航、单次 Markdown 渲染、按需图表加载等既有回归。
- `tests/reader-ui.cjs`：继续阅读、失效记录、手机抽屉焦点与 inert、快速导航竞态、搜索取消、键盘选择、同页打开、Reduce Motion 滚动、阅读浮层生命周期。
- `tests/run.py`：包含新的笔记本入口 HTML 和 partial 响应检查。PHP 8.3.36：46 项运行时检查；42 个用例中 40 通过，2 个因未运行 Docker Nginx 和完整浏览器 PDF 导出而跳过。
- 本地浏览器使用合成课程资料检查桌面、390px 手机布局、展开后的文档树、搜索导航和 PDF 额度说明；桌面和手机文档树的 scrollWidth 等于 clientWidth，scrollLeft 为 0。浅色预览通过仅用于测试的 CSS 选择明色分支，不修改系统外观。
- 合成的长笔记单篇 PDF 冒烟检查完成：界面显示已触发 1 个独立 PDF 下载，额度从 120 更新为 119；没有据此声称完整 PDF 浏览器套件或下载文件内容检查已通过。
- 上述本地验收不包含线上 Lighthouse、真机耗电或动画帧耗时录制，不能以资源开销或功能检查代替这些数据。

现有测试库可能含有其他访客的 PDF 任务，因此一条旧清理断言改为检查本次 job_token，避免依赖全库清空。工作区原有的 `tests/pdf_cookie.py` 修改未纳入本次实现。

提交前另以仓库原始 `tests/pdf_cookie.py` 在内存中验证实际提交快照，保留工作区原文件。该检查发现既有 PDF 任务在 30 分钟绝对上限到期后，尚未触发下一次续期条件时仍可能被接受；在统一读取任务处补上绝对到期检查。完整快照的 44 个用例中 41 通过，3 个跳过（Docker Nginx、完整 PDF 浏览器导出、长 PDF 浏览器下载）；46 项运行时检查通过。

本轮补充验证：45 个 PHP 用例中 42 通过，3 个跳过（Docker Nginx、完整 PDF 浏览器导出、长 PDF 浏览器下载）；46 项运行时检查通过。验证时在内存中载入仓库原始的 PDF cookie 测试，未改动工作区原有测试删减。前端和阅读交互套件通过；本地合成内容检查了桌面页底、圆角边界、390px 抽屉、无文档列表的欢迎页与继续阅读。

## 可配置阅读主页

后台「站点设置 → 阅读主页链接」可保存绝对 HTTP(S) 地址，留空关闭。阅读文档的操作区和笔记本入口按需显示英语 Home 按钮，辅助名称为 Return to home。按钮使用原生链接，无额外脚本或请求，不接管文档树的局部导航。

判断使用地址的主机、非默认端口和分享根路径 `/s/{slug}`；忽略 HTTP/HTTPS 协议差异、子文档路径、查询参数、锚点和尾斜杠；兼容反代终止 HTTPS 而 PHP 收到 HTTP 的部署。同一主页分享内不显示按钮，其他分享显示。完整 slug 比较避免前缀误判，支持子目录部署和后台配置的分享链接前缀。保存前拒绝非 HTTP(S)、带用户名密码及无效 URL；旧表单缺少该字段时保留已保存值。

后台不再查询上游 GitHub releases 或显示“有新版”提示；当前站点版本与署名保留，站点跟随此 fork 的部署。

验证：主页功能完整 PHP 回归 46 项中 43 项通过、3 项跳过；移除上游检查后，后台、主页匹配、欢迎页和英语控件 4 项定向回归通过。前端及阅读交互套件通过。浏览器验证了配置保存、手机 Home 跳转及主页内自动隐藏。
