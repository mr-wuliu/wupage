# 开发指南

[返回 README](../README.md)

## 功能调研

- [实时视频翻译可行性调研](research/realtime-video-translation.md)：字幕与音频路线、服务接入、资源预算、实现难点及分阶段验收计划。

## 开发

### 嵌入文档翻译

`src/content/frame-bootstrap.ts` 在匹配的所有框架中登记文档，支持来源回退和特殊 URL，按需加载独立的 `frame-content.js`；顶层 `content.js` 保留唯一的悬浮界面。`src/background/frame-sessions.ts` 通过浏览器提供的标签页、框架和文档身份管理会话，保存会话意图到 session storage，并统一处理开关、语言、显示模式、增量接入、取消和标签页内公平调度。`src/shared/frame-session.ts` 保存协议、状态汇总与排除规则。原有服务商调度和缓存继续生效。

嵌入帧中的视频由 `video-bootstrap.ts` 独立发现，出现视频后加载 `video-content.js`，不要求先开启整页或段落翻译。原有 `paragraph-frame.js` 已由这两条按需入口取代。字幕任务、手动翻译和网页预取共用服务商及全局并发限制，优先级依次降低，同级任务保持先进先出；字幕仍不写入持久缓存。

`src/content/document-viewport.ts` 使用隐式根相交观察判断框架正文与顶层视口的关系，对实际可见段落的临近内容进行有限预取；不依赖跨域 rootMargin。正文采集和渲染由各文档内的现有引擎执行。迟到结果需要匹配会话和文档；框架导航或整页停止会取消对应请求。

`src/content/frame-visibility.ts` 在相邻框架之间同步祖先隐藏状态，并监听普通 DOM 和可访问 Shadow Root 中的样式变化。页面消息仅携带位置相关提示，不传递翻译命令、正文或配置。服务商返回限流、登录或协议错误时，具有相同服务配置的活动会话统一暂停并取消排队请求；暂停状态随会话意图保存，明确重试或更换服务配置后解除。

构建后运行 `npm run test:frames`（Chrome）、`npm run test:frames:firefox` 或 `npm run test:frames:edge`。测试使用独立资料目录、本地网页和模拟服务，覆盖同域、跨域、嵌套、srcdoc、空白文档、blob、data、sandbox、闭合 Shadow DOM 内的框架、显示模式、语言切换、隐藏后展开、延迟加载、排除规则、取消及超高框架的外层滚动。Chrome 支持 `CHROME_TEST_BROWSER`，Edge 支持 `EDGE_TEST_BROWSER`（省略时使用 Playwright 的 `msedge` 通道），两者支持 `PLAYWRIGHT_MODULE`；Firefox 支持 `FIREFOX_BINARY`。直接运行测试脚本并传入 `--live` 可检查模组详情站点实际渲染，使用 `--edge` 或 `--firefox` 选择浏览器。报告和截图按浏览器分别保存在 `.npm-cache/frame-translation/` 下，并记录实际浏览器标识。

### 卡片与列表的排版边界

正文分组遵守嵌套段落、Flex / Grid 单元和行内块字段的边界。同一文本节点只属于一个分组；包含多个阅读区域的列表项不合并为整段译文。段落处于布局单元中时，译文与加载占位保留在该单元内，避免增加横向布局项。独立数字不单独翻译，句子中的数字随完整句子处理。

构建后运行 `npm run test:profile-layout`、`npm run test:profile-layout:firefox` 和 `npm run test:profile-layout:edge`，使用独立 Chrome、Firefox、Edge 配置和本地模拟服务验证宽窄窗口、三种显示模式、卡片宽度、译文边界、描述去重、数字位置和原文节点恢复。环境变量与框架回归相同；直接运行 `node scripts/test-profile-layout.mjs --live`（可加 `--firefox` 或 `--edge`）还会验证 GitHub 个人页。报告与截图按浏览器分别保存在 `.npm-cache/profile-layout/` 下。原有紧凑控件、动态内容和富文本链接回归也可通过 `npm run test:cards:edge` 在 Edge 中执行，产物保存在 `.npm-cache/card-layout/edge/`。

邮件列表等单行省略区域在 `src/content/dom.ts` 中按原有文字字段分组，主题和摘要保留在裁剪容器内；行内译文继承页面的换行规则。构建后运行 `npm run test:mail-layout`、`npm run test:mail-layout:edge` 和 `npm run test:mail-layout:firefox`，使用本地模拟邮件和独立浏览器配置检查表格与 ARIA Grid 的行高、列宽、主题和摘要分离、时间不折行、加载状态、动态新增行、复选框交互、正文换行及原文恢复。不会访问真实邮箱；截图和报告位于 `.npm-cache/mail-layout/<browser>/`。

自定义任务菜单通过 `[task-menu]` 识别，各个 `[role="listitem"]` 独立采集；包含列表项的外层 div 不作为正文聚合。自定义菜单项在译文替换模式下复用原有 Text 节点，并记录实际替换值，保持 Shadow DOM 插槽、状态图标及宿主更新后的正确恢复。构建后运行 `npm run test:task-menu`、`npm run test:task-menu:edge` 和 `npm run test:task-menu:firefox`，使用脱敏后的 Partner Center 菜单结构和本地组件检查开放与封闭 Shadow DOM、两种窗口宽度、三种显示模式、逐项可见性、选中交互及节点还原。每个浏览器运行 16 组检查，产物保存在 `.npm-cache/task-menu/<browser>/`；不访问已登录的商店页面。

### 旧式论文页面翻译

`src/content/legacy-scientific.ts` 识别 LaTeX2HTML 生成标记，将页面根节点下连续的行内内容临时组织为段落，并在清理时还原原始节点。正文中的公式图片和数字引用使用已有的受保护标记协议，译文复用公式图片和引用链接；独立公式、编号和公式图片的替代文本不送去翻译。

构建后运行 `npm run test:scientific`（Chrome）、`npm run test:scientific:firefox` 及 `npm run test:scientific:edge`，环境变量与框架回归相同。测试使用本地原创样例和模拟翻译，检查段落、公式、引用、可见范围调度、三种显示模式和恢复原文。直接运行 `node scripts/test-scientific-page.mjs --live`（可加 `--firefox` 或 `--edge`）还会验证 OpenMX 的实际论文页面。报告和截图按浏览器分别保存在 `.npm-cache/scientific-page/` 下；模拟结果只用于验证采集和排版，不衡量翻译质量。
### 视频字幕实验

`src/content/video-subtitles.ts` 在主页面与嵌入帧中发现视频，每个播放器由 `video-player.ts` 管理独立会话，`video-view.ts` 提供带键盘支持的 Shadow DOM 工具条、折叠设置与字幕覆盖层。仅用户手动开启或明确勾选网站自动开启后才发送字幕文本。播放器控制不操作时收起，设置关闭后继续翻译；字号、背景、原文显示不会重新调用翻译服务。

`src/video/platforms.ts` 隔离网站域名、播放器与字幕选择器。`page-bridge.ts` 只在 YouTube/Bilibili 的页面主执行环境中运行，按当前视频读取字幕目录和字幕文件；通过 Resource Timing 观察播放器已有的字幕请求，不覆盖全局 fetch、XHR 或 JSON 方法。请求地址按协议、域名与路径限制，响应有大小上限。Bilibili 目录中的编码地址先由 `bilibili-url.ts` 转为播放器实际使用的 CDN 路径，保留授权查询参数，再执行地址白名单校验；回归同时覆盖当前目录样本与原始 CDN 地址。Bilibili 字幕 CDN 使用不带凭据的请求，兼容其通配跨域响应；目录接口与 YouTube 字幕仍保留原有登录上下文。手动指定的字幕读取失败时显示错误，不改为翻译其他语言的渲染字幕。页面桥接没有扩展 API 或翻译凭据；隔离环境通过 `bridge-client.ts` 读取经校验的字幕数据，JSON3、Bilibili JSON/字幕目录二进制解析与格式约束位于 `site-cues.ts`、`bilibili-proto.ts`。

标准字幕轨、完整网站字幕和导入文件共用 `SubtitleTranslator` 的 15 秒预取窗口与 256 条缓存；无法取得完整时间轴时由 `LiveSubtitleTranslator` 对当前渲染字幕去抖、串行翻译并立即丢弃过期显示。后台 `video.ts` 按 tab/frame/session 隔离取消操作，限制请求大小、同帧并发和 15 秒任务期限，并复用文本翻译的服务商/全局限流；实时任务优先于已排队的普通页面任务。字幕不写入持久翻译缓存。暂停、seek、广告、SPA 换视频和设置更新由会话版本隔离；停止后恢复字幕模式及扩展修改的原生 CC 状态。

渲染字幕先合并视觉换行与多余空白，采用 250 ms 稳定等待和 900 ms 滚动窗口上限。同一段连续语音使用相互匹配的原文/译文快照，等待下一次结果时按响应速度保留 1.5–2.5 秒；短于 180 ms 的字幕节点替换不清空结果。新句、真正的空白、seek、停止和换视频会清理旧快照，过期请求不能重新显示。回归覆盖 700 ms 和 2.2 s 响应下持续滚动的字幕，以及换行、空白、取消和缓存。

全屏容器沿用覆盖层，视频元素原生全屏使用临时双语 TextTrack。嵌入帧向后台登记视频可用性，显式打开请求由后台定位对应帧，避免在没有视频的顶层页面打开空面板。弹窗的「视频字幕」是功能区全宽开关，保存 `videoTranslation.enabled`，旧配置默认开启；关闭后各文档释放播放器控制器并恢复原字幕，后台取消在途字幕请求并拒绝新请求。首次读取与历史缓存恢复均使用最新设置，重新开启时恢复发现，保留字幕外观与网站自动开启偏好。原生网页字幕和扩展 UI 均排除于全文翻译的扫描范围。原生字幕轨被网站关闭、替换或切到其他显示轨道时，自动模式会重新选择可用轨道并取消旧任务；Bilibili 的自动选择读取网站字幕语言控件。Vimeo 的字幕控件挂在完整播放器内，避免受到画面内层 aria-hidden 的影响。

本地与商店版同时安装时，可运行 `npm run build:video-preview`，再在 Chrome / Edge 的扩展管理页加载生成的 `dist-video-preview/`。这个构建显示为「WuPage 视频字幕预览版」，工具栏图标悬停也使用该名称；打开它的弹窗应能看到「视频字幕」按钮。更新后重新加载此扩展并刷新视频页。普通 `npm run build` 仍向 `dist/` 生成正式名称的构建；预览输出目录独立，名称与 `version_name` 仅用于本地识别，不改变版本号或发布配置。浏览器回归可用 `VIDEO_TEST_EXTENSION_DIR=dist-video-preview` 指定预览构建。

验证命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:video
npm run test:video:sites
npm run build:firefox
npm run test:video:firefox
```

`test:video` 及 `test:video:edge` 使用本地生成的真实视频、WebVTT 与模拟服务，验证功能开关、三种弹窗宽度、播放器入口、预取、外观、seek、容器/原生全屏、文件导入、限额错误和跨域 iframe；另检查关闭后原字幕恢复、已有页面同步移除入口，以及重新开启。`test:video:sites` 将九类站点 URL 路由到本地播放器样本，验证选择器、网站桥接、协议、YouTube 广告/SPA 导航及停止恢复；它证明样本适配，不代表已登录真实网站的验收。两个脚本支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`，视频回归另支持 `CHROME_TEST_BROWSER`、`EDGE_TEST_BROWSER`；报告分别写入 `.npm-cache/video-subtitles/<browser>/`、`.npm-cache/video-sites-regression/`。`test:video:firefox` 通过项目现有 Marionette 工具控制本机 Firefox，使用独立资料目录与本地模拟服务，覆盖跨域播放器关闭、恢复原字幕与重新开启，报告写入 `.npm-cache/video-firefox/`；支持 `FIREFOX_BINARY`。

`node scripts/test-video-mobile.mjs --edge` 在桌面 Edge 中模拟手机视口、粗指针和触摸输入，将 `m.youtube.com` 路由到本地视频样本，验证移动播放器 API、`ytInitialPlayerResponse`、播放器已请求的字幕地址及渲染字幕四条路径。覆盖相对字幕地址、保留 MWEB 授权参数、轻触后显示入口、44px 触摸目标、seek、原生视频全屏和切换视频后的旧数据隔离。去掉 `--edge` 使用 Chromium；支持 `PLAYWRIGHT_MODULE`、`CHROME_TEST_BROWSER`、`EDGE_TEST_BROWSER` 和 `VIDEO_TEST_EXTENSION_DIR`，报告与截图位于 `.npm-cache/video-mobile/<browser>/`。这属于桌面浏览器移动模拟，不替代 Android Edge 真机与真实 YouTube 验收。

`npm run test:video:performance` 使用本地循环视频、持续变化的渲染字幕和模拟服务，记录开启前后的 renderer 任务时间、脚本时间、强制 GC 后的 JS heap、节点与监听器数量，并检查停止后不再请求、移除播放器后清理入口。默认观察 120 秒，可用 `VIDEO_SOAK_SECONDS` 延长至 3600 秒；报告位于 `.npm-cache/video-performance/`。这不是浏览器全部进程的 CPU、内存或真实网站长时间观看验收。

2026-10-29 的 `1.4.1-video-preview.9` 预览包与相同依赖下的 `fa74781`（1.4.1）比较，Chromium 安装文件增加 116,901 B，本地 DEFLATE level 6 ZIP 估计增加 35,977 B（约 35.1 KiB），没有新增依赖或模型。Windows / Chromium 147 的较早渲染字幕构建中，600 秒资源样本完成 1,251 次本地模拟请求，超过会话缓存容量后，后五分钟页面 JS heap 约在 2.96–2.97 MB；全程 heap 净增 237,440 B。多数样本监听器为 137，停止后请求数不再增长，移除播放器后监听器降至 106；renderer 任务时间从关闭时约 0.0040 s/s 到开启时约 0.0087 s/s。上述数字是单一轻量测试页的观察值，不能推导整机占用、网站视频解码表现或总内存预算。

发布前还需在目标站点的正常账号/网络环境中检查真实字幕、换集、语言切换、全屏、停止及至少 30 分钟连续观看。只看到绿色样本回归或成功构建不足以宣称所有网站生产可用。

真实页面检查：YouTube 已在正常 Edge 环境读取完整字幕时间轴，Microsoft 翻译返回中文，37→42 秒跳转及后续播放点返回对应译文；TED 的 v7 已在独立 Chrome 中通过真实网站与 Microsoft 免费服务验证：英文完整字幕时间轴、英语切法语后继续翻译、切回无翻译署名的英文、26→121 秒跳转、真实容器全屏及退出，以及停止后恢复所有修改过的字幕轨与原生层。TED 的当前选择由字幕菜单与翻译署名识别；播放器在语言切换后延迟禁用字幕轨时，仅恢复当前选中轨道的读取，不清空已完成的译文缓存。TED 的 v7 另完成真实媒体原生字幕路径连续播放：观察 1,811.7 秒，媒体累计前进 1,811.6 秒，包含一次原视频循环；181 次约 10 秒间隔采样未见暂停或服务错误；循环起点有一次 readyState=1，下一次约 10 秒后的采样已恢复为 4 并继续显示译文。出现原文而没有译文的样本为 0 次，最长采样间隔 10.02 秒。这是分段采样，不能等同逐帧证明字幕始终无延迟。Bilibili 的 v4 在独立、未登录的 Chromium 中通过真实网站与 Microsoft 请求验证：解码目录地址、读取完整时间轴、20 秒出中文、跳至另一条实际字幕（31.3 秒）以及停止恢复原生层。正常 Edge 的 v4 也已读取完整时间轴、显示中文，停止后恢复原生层。v7 在独立、未登录 Chromium 中补充验证了真实 Bilibili 容器全屏、退出恢复和跳转；该环境的原生语言菜单要求登录，没有强行激活隐藏选项。正常 Edge 的已有登录状态已验证网站英语切到日语后，扩展跟随新字幕并返回 Microsoft 中文；原生菜单回选英语没有形成确定证据，不能计为已通过。当前地址转换参照[网站公开播放器](https://s1.hdslb.com/bfs/static/player/main/core.9c6ca999.js)，只转换字幕路径，之后仍执行原有地址白名单检查。

YouTube 的正常 Edge 长测使用 v3、Microsoft 免费翻译与渲染字幕路径：观察窗口 1,867.3 秒，视频实际前进 1,825.3 秒；179 次分段采样未观察到暂停、未就绪或服务错误，一次新句等待在下一次约 0.8 秒后的采样恢复。最长采样间隔 295.4 秒，这不是逐帧监测。v5 修复了真实 YouTube 整页全屏时 HTML 根盒高度为零导致入口隐藏的问题；正常 Edge 已验证全屏中的双语字幕、设置面板，以及退出后恢复到播放器内。对应的零高度整页全屏、容器全屏和原生视频全屏均纳入浏览器回归。v6 还在正常 Edge 中关闭网站自动开启，手动启用后点击站内推荐视频，从 n8n 切到 Godot；会话仍保持启用，新视频时长与字幕已更新并返回中文。

Udemy 的正常 Edge 公开试看在无课程账号的情况下提供英文 CC，当前播放器使用 `data-purpose="media-player-container"`、`_caption-container_` 与 `_cue-text_`。实机复现了旧选择器读取为空，v8 增加新容器支持并保留旧播放器适配；正常 Edge 已验证英文 CC 到 Microsoft 中文、网站切换日语后继续翻译以及切回英文。换到另一条公开讲座时，实机发现旧控制器的断连清理早于新播放器发现，导致手动开启状态丢失；v9 保留清理前的开启意图供发现器接续，并立即取消旧会话，主动停止仍清除意图。单元与真实 MV3 浏览器回归覆盖延迟换视频、重新挂载和停止后换视频；正常 Edge 的 v9 已验证从 Course Introduction（399.8 秒）切到 Python Numbers（251.4 秒）仍保持手动开启并显示新讲座对应中文；主动停止后切到 For Loops（1,097.6 秒）保持关闭。整页翻译现在按当前站点字幕选择器排除原生层，避免在字幕翻译尚未返回时改写原文，其他域名使用相同类名的普通文本仍可翻译。正常 Edge 已确认真实播放器全屏，字幕覆盖层和设置面板位于全屏容器内；全屏中停止后原生层 opacity 恢复为 1，退出全屏保持停止状态。独立 Chrome 访问相同公开课程页返回 HTTP 403，未将其记为播放通过。公开试看不能代替已购买课程或登录学习页验收。

独立测试环境中，部分 YouTube 原生 timedtext 请求仍返回空正文；Vimeo 已在正常 Edge 中读取完整英文字幕、播放并取得 Microsoft 中文译文；v6 修复入口位于 aria-hidden 画面内层、以及网站更换原字幕后仍停留旧轨道的问题。实机已验证英语切法语后继续出中文、文字稿侧栏打开时字幕对齐视频、真实播放器全屏、停止后保留网站新选语言及恢复原生字幕层。独立 Chrome 的同一演示媒体长时间缓冲，未安装扩展的基线也未起播，不能将该环境记为播放通过。Netflix、Disney+、Prime Video 和课程站的登录实机验收仍需补充。这些站点仍需分别完成真实播放验收，不能由本地样本或模拟服务测试替代。画中画、图片字幕、封闭 Shadow DOM 和没有网站字幕的内容不属于现有读取路径。

2026-10-29 的 v9 在正常 Edge 中补充了 Bilibili 与 Vimeo 的真实媒体循环长测，均使用 Microsoft 免费翻译到中文。Bilibili 使用现有登录状态，扩展手动选择 English(US)；Vimeo 跟随播放器英文字幕。两站都读取完整时间轴，观察窗口为 2,014.3 秒：

| 站点 | 采样确认的累计播放 | 观察到的循环 | 采样数 | 暂停 / 未就绪样本 | 有原文无译文样本 | 服务错误样本 |
| --- | --- | --- | --- | --- | --- | --- |
| Bilibili | 2,004.8 秒 | 10 次 | 136 | 2 / 2 | 0 | 0 |
| Vimeo | 1,825.1 秒 | 30 次 | 136 | 0 / 0 | 0 | 0 |

Bilibili 的两次暂停样本均位于循环起点（约 0.321 秒、readyState=1），下一次约 10 秒后的采样已恢复播放、readyState=4；翻译开启状态和英文轨道选择一直保留。两站分别有 93、100 个样本包含原文，均同时存在译文。停止后已检查原生字幕隐藏标记清除，并恢复临时循环和原翻译服务设置。报告位于 `.npm-cache/video-sites/public-sites-edge-v9-soak.json`，结束前截图为同目录的 `bilibili-edge-v9-soak-final.jpg` 和 `vimeo-edge-v9-soak-final.jpg`。

采样通常间隔约 10 秒，最长间隔 166.52 秒。累计播放由相邻媒体时间与观察到的循环计算，长间隔内不可见的完整循环未补算。这是同一媒体循环的分段观察，不能等同逐帧字幕延迟监测或持续新字幕负载测试。此前独立、未登录的 Bilibili 长测在媒体约 61.6 秒处暂停，扩展仍开启且未显示服务错误；原因未确定，未将该次运行记为通过。上述正常 Edge 结果不替代 Netflix、Disney+、Prime Video、Coursera 和 Udemy 已购课程的登录播放验收。

### 从源码构建

需要 Node.js 22 或更高版本，以及 npm。

```bash
git clone https://github.com/mr-wuliu/wupage.git
cd wupage
npm ci
npm run build
```

构建完成后，按照 [README 中的手动安装说明](../README.md) 加载 `dist/` 目录。

### 日常开发

```bash
npm run dev        # 监听源码并持续构建
npm run typecheck  # TypeScript 类型检查
npm test           # 运行 Vitest 测试
npm run build      # 生成生产构建到 dist/
```

### 快捷键实现与验证

`shortcutWarning()` 对常用浏览器、编辑和 Ctrl＋Alt 组合给出非阻断警告。警告只显示在对应录入框下方，不设置 `aria-invalid`，不会阻止保存或在设置规范化时重置绑定；重开设置页仍会显示。格式错误和扩展内重复绑定保持原有校验。

`shortcutEnabled` 为四项翻译快捷键与四项局部操作分别保存布尔开关。缺失的旧设置默认启用，原先清空的翻译键迁移为关闭；关闭只改变开关，不清空 `shortcuts`。设置页将两者作为同一份草稿保存，恢复全部默认会重置按键及开关。内容脚本、悬浮球、段落点击和划词卡片通过同一个存储事件同步配置；局部键关闭后仍可使用鼠标按钮。

快捷键保存在扩展设置的 `shortcuts` 中，在设置页直接录入、清空或恢复默认，与其他表单字段一起保存。`src/shared/shortcuts.ts` 统一定义默认值、组合键规范化、事件匹配和已知冲突校验。未配置的新字段补齐默认值，明确清空的值保留为空，非法或重复绑定在读取设置时修复。Chrome / Edge 不提供扩展内改写浏览器快捷键的接口，因此不再声明 Manifest `commands`，避免旧原生绑定与自定义按键同时触发。相关接口范围参见 [Chrome Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)。

`src/content/keyboard-shortcuts.ts` 在顶层网页捕获按键，根据已加载的配置触发 `src/content/shortcuts.ts` 中共用的翻译动作。使用 `KeyboardEvent.code` 匹配字母和数字物理键；忽略 IME、AltGr、输入和编辑区域、已处理事件与重复执行；仅在匹配时阻止网页默认行为。配置变更通过存储事件同步，初始读取不会覆盖较新的存储变更。快捷键作用于普通网页及已接入的嵌入框架正文，不作用于地址栏或 PDF 查看器。全文开始前的异步读取可被再次按键取消，过期结果不覆盖恢复原文后的提示，连续切换显示模式按保存顺序处理。

段落翻译快捷键复用 `src/content/paragraph-translation.ts` 的原位翻译与恢复逻辑。`src/content/paragraph-shortcut.ts` 将选区内的文字映射为完整段落并去重，无选区时使用鼠标所在或获得焦点的正文段落；不依赖段落模式、右键翻译或划词翻译开关。配置键沿用 `translate-selection`，保留已有自定义按键与开关。

相关单元回归覆盖录入、取消、清空、默认值、重复及保留组合键校验、设置保存和分类草稿、即时改键与输入保护、快速启停、显示模式顺序和段落翻译。

`npm run test:shortcuts` 在构建后加载真实扩展，使用独立浏览器资料和本地模拟服务验证设置页录入与保存、无需刷新网页的改键和停用、实际键盘事件触发全文与段落翻译、译文模式复用、段落模式、输入保护与窄屏布局。支持 `PLAYWRIGHT_MODULE`、`CHROME_TEST_BROWSER` 和 `PDF_TEST_BROWSER`，报告及截图写入 `.npm-cache/shortcuts/`。浏览器和系统保留快捷键不由网页拦截，跨系统组合仍需在目标环境确认。

### 右键全文翻译

右键全文翻译由 `src/background/page-context-menu.ts` 维护单一顶级菜单，并清理旧版两个段落菜单。正文菜单仅使用 `page` 上下文，与图片菜单分开，避免 Chromium 自动折叠为子菜单。页面翻译状态变化、切换标签页或窗口以及页面导航时重新读取顶层文档状态；异步读取通过序号丢弃过期结果。点击复用全文翻译快捷键的实时切换动作，翻译中也能取消并恢复原文。

构建后运行 `npm run test:context-menu`，使用真实扩展与本地模拟服务验证菜单更新、全文启停、标签页切换、导航和延迟响应取消。支持与快捷键浏览器回归相同的环境变量，报告写入 `.npm-cache/context-menu/`。原生菜单注册与点击路由另由单元测试覆盖。

### Firefox 构建与验证

Firefox 需要 154 或更新版本。两种浏览器共用业务源码，分别生成安装目录：

```bash
npm run build          # Chrome / Edge：dist/
npm run build:firefox  # Firefox：dist-firefox/
npm run dev:firefox    # 监听修改并重新生成 Firefox 构建
```

在 `about:debugging#/runtime/this-firefox` 中临时加载 `dist-firefox/manifest.json`。源码修改后先完成构建，再点击该页的「重新载入」，并刷新普通网页。临时扩展退出浏览器后失效；正式安装需要 Mozilla 签名。

`public/manifest.json` 是共享配置；`build/manifest.ts` 生成 Firefox 的后台脚本、扩展 ID、最低版本和数据传输声明。版本号保持与共享 Manifest 一致。Firefox 154 提供 OCR 依赖的扩展沙箱。两种浏览器均使用专用 OCR 运行库，OpenCV WASM 独立保存，避免将二进制编码到 JavaScript 中。

Firefox 的后台事件页通过隐藏 iframe 托管 OCR 和 Bergamot。仅在模型下载期间发送内部心跳，防止关闭界面后后台空闲卸载；任务结束立即停止。Firefox 的 Bergamot 适配从扩展页面读取随包附带的 WASM 并转交 Worker，支持首次断网启动。Chrome / Edge 继续使用 offscreen 文档与原始 Worker。

```bash
npm run test:firefox
npx web-ext lint --source-dir dist-firefox
```

`test:firefox` 使用本机 Firefox 的 Marionette 测试接口和独立资料目录，不依赖浏览器驱动，不访问日常浏览数据。Windows 默认查找标准安装位置；其他位置或系统可通过 `FIREFOX_BINARY` 指定可执行文件。运行前先构建 Firefox 包。

测试使用本地网页、PDF 与模拟翻译服务，验证设置持久化、三种译文模式、Ollama 请求头、本地和在线 PDF、真实 OCR 识别与缓存、模型删除，以及关闭所有扩展界面超过 30 秒后继续下载模型、首次断网英译中和自动检测。模型从官方地址下载并缓存；Bergamot 也可通过 `LOCAL_MODEL_FIXTURE_DIR` 使用已保存的模型文件。只有临时测试包中的模型下载地址会重定向到本地服务器，生产校验和推理实现保持不变。报告和截图保存在 `.npm-cache/firefox/`。

项目主要目录：

```text
src/
├── background/  # 服务商适配、任务调度、缓存与消息处理
├── content/     # 网页文本识别、译文渲染、段落模式与悬浮球
├── local/       # Bergamot 模型目录、续传缓存、离线导入、Worker 与管理界面
├── options/     # 设置与服务商配置界面
├── pdf/         # PDF 加载、布局、编辑、渲染与导出
├── popup/       # 扩展弹窗交互
└── shared/      # 类型、默认设置、语言与跨上下文工具
tests/           # Vitest 测试
public/          # Manifest 与扩展图标
```

LLM 高级请求模板由 `src/shared/request-template.ts` 统一解析、校验并应用于 OpenAI、Anthropic、DeepSeek、智谱及视觉请求。模板先解析 JSON，再在值中替换变量，防止原文中的引号或换行改变请求结构；请求体采用 JSON Merge Patch 语义，请求头按名称大小写无关地覆盖或删除。配置保存在各服务的 `requestTemplate` 中，未配置或禁用时沿用原请求。设置页的选项卡与模板编辑位于 `src/options/provider-advanced.ts`。相关回归覆盖模板合并、变量转义、保存与禁用、实际请求参数、校验失败和键盘切换。

默认文本请求和设置页模板共用 `defaultLlmRequestTemplate`，运行时通过 `defaultLlmRequest` 替换变量，避免预览与实际请求的字段漂移。空配置在编辑框内展示默认模板，未编辑的展示内容不会持久化为覆盖参数；「载入默认模板」启用并复制模板，「恢复默认请求」清除覆盖并恢复默认展示。认证头按常规设置中的凭据是否存在生成，展示和载入时只使用密钥占位符。

`npm run test:templates` 在构建后加载真实扩展，通过本地 HTTP 服务检查四类 LLM 的自定义请求头和请求体、设置重载、关闭与恢复、校验错误、HTTP 模板兼容及窄屏布局。支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`，报告与截图保存在 `.npm-cache/request-templates/`，不访问真实付费接口。

提交改动前建议依次运行：

```bash
npm run typecheck
npm test
npm run build
```

### 网页翻译回归验证

本机 Chrome 可通过 `CHROME_TEST_BROWSER` 指定路径运行同一套网页翻译回归。测试使用独立资料目录、本地网页与模拟服务，不读取日常浏览资料。先运行 `npm run build`，再在 PowerShell 中执行：

```powershell
$env:CHROME_TEST_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:page
```

需要可导入的 Playwright（也可用 `PLAYWRIGHT_MODULE` 指定模块路径）。Chrome 通过扩展调试接口加载 `dist/`，报告与截图写入 `.npm-cache/chrome-translation/`。

- 自动翻译由 `src/shared/auto-translation.ts` 归一化并匹配站点规则，`src/content/auto-translation.ts` 在前台 HTML 页面触发现有渐进翻译。弹窗和悬浮菜单的「＋」复用站点添加逻辑，只从 HTTP/HTTPS 地址提取域名和非默认端口，不保留路径、查询参数或片段；已有整站规则会复用，同站点的已停用规则会启用。「✓」再次点击后将当前域名写入可选的 `excludedSites`，优先于站点及语言规则；保留正向规则以继续服务其他子域名，重新加入时清除该域名的排除。设置页草稿读写保留排除项，并可单独取消排除。语言检测仅使用本机浏览器接口；路由、配置与手动停止会使过期检测结果失效。回归覆盖域名边界、通配与路径、旧设置默认关闭、动态内容、手动停止和单页导航。
- `npm run test:auto`：构建后加载实际扩展，使用本地网页和模拟翻译服务验证规则保存、窄屏、自动触发、手动恢复原文、单页导航、目标语言跳过和异步加载的正文；另检查弹窗和悬浮菜单加入、排除及重新加入当前网站、重复规则限制、设置页持久化与保存后保留排除项、排除优先于语言规则且刷新后有效，以及新增站点立即触发翻译。报告保存在 `.npm-cache/auto-translation/`。
- `npm run test:spa`、`npm run test:spa:edge`、`npm run test:spa:firefox`：构建对应浏览器产物后，使用独立浏览器和本地帖子页面验证站点规则与语言规则下的连续切换、前进后退、仅改变地址时的路径边界、延迟响应、原文节点复用、动态回复、手动还原与重译，以及空白加载页的后续翻译。站点规则继续匹配时保留现有监听；需要重新判断语言时等待后台停止完成，内部暂停不视为用户手动还原。中断、仍在翻译与暂时没有正文分别显示对应状态。报告与截图保存在 `.npm-cache/spa-translation-<browser>/`，支持 `PLAYWRIGHT_MODULE`、`CHROME_TEST_BROWSER`、`EDGE_TEST_BROWSER` 和 `FIREFOX_BINARY`。
- 六个预置在线翻译服务通过 `serviceMode` 区分 `free`（默认）和 `api`，凭据保存在对应配置的 `api` 中。免费分支不读取或发送这些凭据；切换方式会保留已有配置。旧版内置 Azure / Google Cloud 配置在规范化设置时迁移至对应服务商，存在不同凭据时保留独立配置。火山 API 在后台通过 Web Crypto 生成 V4 签名；腾讯 API 使用 TokenHub 的翻译模型。
- `npm run test:services`：构建后加载实际扩展，以模拟网络响应验证六家服务的免费/API 切换、设置保存、凭据保留、实际请求分支和窄屏布局，不访问真实付费服务。支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`，报告保存在 `.npm-cache/service-modes/`。
- 服务额度资料保存在 `src/shared/provider-usage.ts`，设置页在切换服务、使用方式、模型或地址时更新。维护数值时须核对所链接的官方资料并更新核对日期；匿名接口与云 API 分开，官方未公开的数字不以经验值代替。`src/options/provider-usage.ts` 单独显示插件调度设置，不能将 RPM、QPS 和并发混用。说明仅使用随扩展打包的资料，不查询账号余额或额外请求第三方接口。
- 另外预置 `tencent-transmart`、`yandex-web-translate`、`volcengine-web-translate` 与 `mymemory`。免费模式下，腾讯使用批量请求，Yandex 与火山逐项处理以保留段落对应关系；MyMemory 在本机检测源语言，并按 500 UTF-8 字节分段，保留空白、Unicode 字符、占位符及实体字面量。回归测试覆盖错误响应、额度限制、取消和旧配置兼容。
- 服务图标随扩展内联打包，弹窗、悬浮菜单和 PDF 共用带图标的服务选择器；设置页复用同一图标映射。图标来源与 MIT 许可保存在 `public/licenses/lobe-icons.txt`，显示时无需访问外部图片服务器。
- `npm run test:page`：先运行 `npm run build`，再使用可选的 Playwright 与 Chromium 加载真实 MV3 扩展。支持 `PLAYWRIGHT_MODULE` 与 `PDF_TEST_BROWSER` 环境变量。
- 使用本地页面和本地模拟翻译服务，覆盖两种窗口宽度、三种显示模式、代码占位符损坏恢复、隐藏内容与草稿排除、Ctrl 点击段落翻译、清除还原，以及动态原文更新后的迟到响应。切换显示模式不得新增翻译请求。
- YouTube 新旧评论结构按整条正文翻译，双语译文另起一行；同时检查短评论、带链接的富文本、长译文自动折行及网页 `white-space: nowrap` 的继承隔离。
- 同时检查 `dist/content.js` 能作为普通脚本解析，防止公共工具被拆成模块导入而导致内容脚本无法加载。报告保存在 `.npm-cache/page-translation/report.json`。
- `npm run test:cards`：使用实际扩展和本地模拟服务，检查中英文界面下的混合语言卡片。覆盖 Flex/Grid 字段分离、标题字号与字重、作者链接、两种窗口宽度、三种显示模式和清除还原；匿名服务将整批判为目标语言时，未翻译项应独立重试。报告保存在 `.npm-cache/card-layout/`。
- `npm run test:floating`：加载实际扩展，覆盖真实指针的 500 毫秒悬停延迟、离开取消、拖动与位置保存、悬浮球和弹窗的翻译中停止、迟到响应、原译文切换与缓存复用、动态列表、状态同步、缓存清理、失败重试、Debug、设置入口、键盘操作和小窗口。另检查紧凑菜单布局、划词开关与弹窗的双向同步、缺少 OCR 模型时禁用图片翻译，以及说明弹层的边界。报告保存在 `.npm-cache/floating-interactions/`。
- `npm run test:paragraph-mode`（Chrome）和 `npm run test:paragraph-mode:edge`：在加载扩展前先打开本地网页，验证暂时未连接不会禁用「段落翻译」按钮，提示刷新后可在同一弹窗重试，并检查顶层与嵌入文档的 Ctrl 点击翻译、恢复和退出同步。弹窗与悬浮菜单使用独立按钮启停段落模式，显示方式下拉框仅保留三种译文样式，切换样式保持段落模式；同时检查窄弹窗的按钮排版。使用独立配置和本地模拟服务，支持 `PLAYWRIGHT_MODULE`、`CHROME_TEST_BROWSER`、`EDGE_TEST_BROWSER`；报告和截图按浏览器保存到 `.npm-cache/paragraph-mode/`。
- 段落模式通过 `src/shared/paragraph-mode.ts` 监听独立的本地共享开关，由后台串行保存。标签页会话只负责全文翻译，不持有段落模式；初次读取与页面从历史缓存恢复时均防止旧值覆盖新的开关事件。嵌入文档保留既有排除规则，并按需激活段落处理。`npm run test:paragraph-sync` 及其 `:edge`、`:firefox` 版本使用多标签页与本地模拟服务，检查双向同步、跨域帧与排除项、新页面、刷新、晚加载帧、已有段落/全文译文保留、快速切换及旧设置保存，报告在 `.npm-cache/paragraph-sync/`。
- 正文和标题译文继承原文字体与行高。需要放在原文外侧以避开截断的结果，由 `src/content/translation-typography.ts` 同步字体；仅在存在此类结果时监听尺寸、祖先样式和字体加载变化，清除结果后释放监听。`npm run test:paragraph-typography` 及其 `:edge`、`:firefox` 版本使用真实键盘快捷键与本地模拟译文，检查多行标题、富文本、手动换行、两种窗口宽度、网页样式变化、三种显示模式及原文恢复；缩放不得重新请求翻译。加 `-- --live` 还会检查 Rust 官网，报告保存在 `.npm-cache/paragraph-typography/`。
- `npm run test:floating-responsive`：使用实际扩展和触屏仿真，覆盖 iPad Pro 13 的 1032 × 1376 竖屏与横屏。检查长按打开菜单、松手保持、外部轻点关闭、拖动取消长按、轻点翻译，以及首次翻译失败自动打开菜单的服务、语言与显示模式、菜单边界和触屏选择操作；另验证纯触屏隐藏段落模式及说明、鼠标环境保留入口，以及弹窗隐藏后的紧凑布局。报告与截图保存在 `.npm-cache/floating-responsive/`，支持 `PLAYWRIGHT_MODULE` 与 `PDF_TEST_BROWSER`。
- `npm run test:settings`：延迟返回设置，逐帧检查弹窗和设置页重开时的图片翻译开关；保存为开启或关闭的状态都不得闪现错误位置或启动动画。报告保存在 `.npm-cache/settings-initialization/`。
- 网页回归还包含明暗背景、现代 CSS 颜色和网页强制文字颜色下的实际颜色检查，切换原色、双色和替换模式时不得新增翻译请求。
- 翻译链路的审视结论与兼容处理边界见 [翻译系统审视](translation-review.md)。

### 局部快捷键

`localShortcuts` 保存段落点击修饰键、划词提交、浮层关闭、悬浮球翻译和菜单进入的独立绑定，原有 `shortcutEnabled` 四项局部开关保持兼容。`src/shared/local-shortcuts.ts` 负责规范化、物理按键匹配、平台默认 Ctrl/Command 提交和提示文字；单键限于 Enter、Space、Esc、方向与功能键，字母数字需要 Ctrl、Alt 或 Meta。清空绑定关闭对应开关；悬浮球两个绑定都清空才禁用共用开关。

`src/options/local-shortcuts.ts` 提供段落修饰键选择和局部按键录入，校验局部与页面动作重复，保留关闭状态的绑定，支持单项及全部重置。浮层关闭与提交仅在对应界面生效，悬浮球阻止旧 Enter/Space 默认按钮激活导致重复触发；输入法合成和 AltGr 不执行绑定。网页、嵌入框架、划词卡片及提示文字监听已保存配置；框架激活时直接使用会话配置，避免默认按键先于自定义配置启用。

构建后运行 `npm run test:local-shortcuts`、`:edge`、`:firefox`，通过独立配置和本地服务验证录入、冲突、持久化、页面与框架点击、旧按键停用、卡片编辑与关闭、悬浮球操作、即时更新和窄窗口。报告与截图位于 `.npm-cache/local-shortcuts/<browser>/`。

### 外观配置与验证

设置页根元素预留对称滚动条占位，避免长短分类切换时居中布局改变位置。保存栏与设置卡片保持普通文档流和 16px 间距，统一用于所有分类；长页面滚动时不将保存栏吸附到视口底部，避免遮住表单与效果预览。

构建后运行 `npm run test:settings-layout`、`npm run test:settings-layout:edge`、`npm run test:settings-layout:firefox`，检查宽窄窗口下全部分类的横向对齐、外观子页切换、展开色组后的不同滚动位置、卡片间距及保存按钮命中。截图与几何报告保存在 `.npm-cache/settings-layout/<browser>/`。

「菜单功能」在 `appearance.popupMenu` 中保存入口顺序、隐藏项与显式 `rows` 行布局，目录和兼容性规范化位于 `src/shared/popup-menu.ts`。旧配置默认显示全部入口，未知 ID 和重复项会过滤，缺少的新入口追加到末尾。缺少 `rows` 的旧配置按原先 PDF、视频整行规则迁移，已设置的新行布局不受功能类别约束。弹窗与编辑预览共用两列网格与行布局，每行一个按钮铺满、两个按钮平分；移动现有节点以保留事件、功能状态与 OCR 控件。GitHub 和官网移入独立底部容器，顺序固定且保留隐藏偏好，鼠标和键盘排序均排除链接。段落模式的触屏限制独立生效，空网格收起。设置入口与语言、服务、显示模式固定保留。`src/options/popup-menu.ts` 提供左侧点击移除、右侧点击追加、Pointer Events 拖动排序、行中配对、行间独占、拉开恢复整行与让位动画；拖动占位和浮层随实际宽度变化，目标区域锁定避免合并后的排版反复跳动；拖动阈值防误触，松开后抑制点击删除，Esc、指针取消和预览外释放恢复原顺序，边缘滚动支持长菜单，减少动态效果偏好会禁用动画。键盘支持 Alt + 方向键/Home/End 排序和 Delete/Backspace 移除。所有操作修改独立草稿，保存复用现有外观设置流程。

构建后运行 `npm run test:menu-layout`、`npm run test:menu-layout:edge`、`npm run test:menu-layout:firefox`，以独立浏览器配置验证 12 个入口的双向移动、底部链接固定、跨类别键盘与真实指针排序、长按钮配对与拉开、行布局保存及旧配置迁移、吸附提示、拖动取消与防误删、保存前预览、已打开弹窗同步、节点与按钮行为保留、旧弹窗保存兼容、空网格收起、恢复默认及宽窄窗口。报告与截图保存在 `.npm-cache/menu-layout/<browser>/`。单元测试另覆盖旧配置兼容、异常 ID、重复项、触屏能力限制和无关设置保存不产生布局变更。

`src/shared/appearance.ts` 管理内置方案、自定义颜色校验和明暗方案选择；`appearance-runtime.ts` 监听系统明暗及本地设置变化，通过 `--wp-*` 变量应用到扩展界面。网页中只注入扩展专用变量，不修改宿主页面的 `color-scheme`；划词卡片在 Shadow DOM 中继承同一组变量。`src/options/appearance.ts` 保存独立表单草稿，与其他设置分类一起提交。

配色按界面、悬浮球、译文与段落、划词翻译、图片入口分组。`src/shared/translation-colors.ts` 共用网页背景识别和对比度处理；内容脚本在方案或系统明暗变化时原地更新已渲染的双色译文，包括段落翻译和图片段落，不重新发送翻译请求。旧自定义方案缺少组件颜色时从原有界面色补齐。

`appearance.floatingOpacity` 独立于配色方案，保存 0–100 的整数百分比，旧配置默认 100。滑块与数字输入共用草稿并即时更新预览，数值超出范围或为空时阻止保存；导入设置会将有限数值取整并限制范围。运行时映射为 `--wp-floating-opacity`，作用于球体和预览，拖动时以该值乘原有的 0.92 系数，展开菜单保持正常不透明度。

`tests/appearance.test.ts`、`tests/options-appearance.test.ts` 和 `tests/translation-appearance.test.ts` 覆盖旧设置兼容、异常色值、系统切换、方案复制与删除、草稿保存、透明度联动、数值校验及双色译文更新。`npm run test:appearance` 构建后使用可选 Playwright 与 Chromium 检查实际组件配色、透明度键盘操作与拖动、数字输入与预览、保存后球体及拖动透明度、菜单可读性、保存重开、译文换色不增加请求以及窄屏布局，支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`，报告保存在 `.npm-cache/appearance/`。

### 划词翻译回归验证

划词设置在 `src/shared/dictionary.ts` 归一化，`src/content/selection-translation.ts` 负责选区入口与隔离样式的结果卡片。简单规则只将不超过 100 字符的单个字母词（允许词内连字符和撇号）交给词典；空释义、多词、句子及中日韩文本使用现有 `TRANSLATE_BATCH`，沿用当前服务、语言、缓存及本地翻译设置，选区上限为 5,000 字符。词典请求失败保留重试，不能作为未收录结果回退。后台固定访问有道和 Bing 的词典端点，词条适配在 `src/dictionary/parsers.ts`；Bing HTML 在共享扩展运行页的惰性模板中解析，不执行或挂载远程页面内容。发音下载有来源、类型、大小和超时限制，由扩展运行页播放；词典请求不携带网页上下文或 Cookie，查词结果不写入翻译缓存。

- 原文使用卡片内的文本框编辑，按钮或 `Ctrl+Enter` 提交，普通回车保留换行。输入立即使旧请求结果失效并停止发音，但不发起新请求；重新提交沿用当前词典及翻译服务分流，不修改网页正文。文本框聚焦时展开，内部滚动不关闭卡片。
- 单元测试覆盖旧配置兼容、两种词条结构、单词分流、未收录回退、直接翻译、当前语言与本地服务复用、长文本与换行、原文编辑与重新提交、输入校验、无效响应、音频来源限制、跨行入口、编辑区域排除和异步结果失效。
- `npm run test:selection`：构建后加载实际 Chromium MV3 扩展，使用本地网页、模拟词典和有效音频验证两家服务、设置保存、原生鼠标划词、跨行下划线、窄屏定位、失败状态，以及页面禁止音频时的扩展内播放。使用独立浏览器资料目录，支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`，报告与截图保存在 `.npm-cache/selection-translation/`。

### 图片翻译回归验证

OCR 使用 `vendor/ocr/` 内的专用 OpenCV 4.10.0 和 ONNX Runtime 1.30.0。普通 `npm ci` 与扩展构建直接使用这些已编译文件，不要求本机安装 C++ 编译器。构建会校验每个文件的 SHA-256、裁剪配置、SDK 版本和模型固定值；模型或运行库版本更新后必须重新编译，不能直接替换通用 WASM。

`src/shared/ocr-control-core.ts` 共用模型状态、安装、删除与帮助交互；弹窗和设置页通过 `ocr-control.ts` 加载样式，内容脚本通过 `src/content/styles.ts` 提供菜单内的限定样式。悬浮菜单显式传入控件和独立帮助 ID，避免匹配网页自身的元素；首次打开时查询模型状态，关闭或移出文档后停止轮询，再次打开时恢复。

专用运行库的源码提交与工具链版本在 `build/ocr/runtime.json`，依赖在 `build/ocr/requirements.txt`。Linux 或 WSL 下重新构建：

```bash
python3 -m venv .npm-cache/ocr-venv
. .npm-cache/ocr-venv/bin/activate
pip install -r build/ocr/requirements.txt
python3 build/ocr/build.py --work-dir .npm-cache/ocr-build-native --jobs 4
```

首次构建需要联网获取固定提交的上游源码、Emscripten 4.0.23 及两个 OCR 模型。脚本校验模型大小与摘要，从 ONNX 图生成所需操作清单，保留 ONNX 格式支持。OpenCV 仅保留 `core`、`imgproc` 和 `build/ocr/opencv.config.py` 中的接口，关闭文件系统；ONNX Runtime 保留 SIMD、单线程推理，裁剪模型未用到的操作与扩展功能。浏览器加载器仍使用标准 `ort-wasm-simd-threaded.*` 文件名，但这对文件来自同一次单线程构建。

OpenCV 4.10 的构建文件还会移除旧 Emscripten 的 demangler 选项及文件系统预加载标志，并适配 C++17 和异步工厂包装器。ONNX Runtime 通过操作裁剪与 LTO 缩小体积，保留 `-O3` 优化以兼顾模型推理速度。完整变换由 `build/ocr/build.py` 记录；生成的许可、第三方声明、操作清单与文件摘要随 `vendor/ocr/` 提交。重新生成文件后运行下列真实 OCR 回归，比较识别文字、坐标与运行时间，再提交运行库更新。`npm test` 排除 `.npm-cache/`，避免将下载的上游源码或旧测试资料目录纳入项目单元测试。

生产构建默认不生成源码映射。调试时可设置 `WUPAGE_SOURCEMAP=1` 后构建；PowerShell 使用 `$env:WUPAGE_SOURCEMAP = '1'`。源码映射仅用于本地排查，不属于浏览器执行所需资源。

- 本地视觉回归页：运行开发预览服务后打开 `tests/fixtures/image-preview.html`，使用固定模型结果检查覆盖、切换、缩放与内部滚动，不调用外部 API。
- `npm run test:ocr`：加载真实扩展，下载并校验公开 OCR 模型到独立测试资料目录，验证沙箱初始化、图片识别、覆盖显示、三次原译图切换、重新打开后的缓存、模型删除和设置持久化。翻译使用本地模拟服务，不使用真实 API 密钥。需要网络下载约 20.5 MB 模型及可选的 Playwright 与 Chromium；报告保存在 `.npm-cache/ocr-flow/`。
- `npm run test:ocr-runtime`：使用实际沙箱、模型和运行库识别中、英、日文，以及透明底、白字和旋转文字。支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER` 和缓存模型目录 `OCR_MODEL_FIXTURE_DIR`。可用 `OCR_BASELINE_DIR` 指向保留的旧构建目录，对比文字及坐标（最多允许 2 像素差异），报告记录初始化与识别用时，保存到 `.npm-cache/ocr-runtime/report.json`。
- OCR 实测页：先 `npm run build`，再 `node tests/fixtures/ocr-preview-server.mjs`，打开 `http://127.0.0.1:5175`，验证真实下载、安装、识别、状态持久化和删除。仅模拟扩展消息，OCR 模型、沙箱和校验使用生产实现。日文透明文字样例还支持真实翻译，以及使用固定译文的符号覆盖与断句回归。
- `npm run test:image-resolution`：需要可选的 Playwright 与 Chromium，支持 `PLAYWRIGHT_MODULE` 和 `PDF_TEST_BROWSER` 环境变量。使用只有 viewBox 的 SVG 与固定译文，检查 1、1.25、2 倍屏幕像素密度下的清晰度、放大后重绘与译文复用；未翻译区域逐像素对照直接绘制的 SVG。脚本也接受本地 SVG 路径，报告保存在 `.npm-cache/image-resolution/`。

### 本地翻译实验与验证

- `firefox-local` 使用固定版本 `@browsermt/bergamot-translator@0.4.9` 的 Worker、JavaScript 和 WASM，构建时复制到对应产物的 `bergamot-runtime/`。Firefox 仅调整 Worker 的 WASM 输入方式，保留相同的引擎与模型字节。执行代码全部随扩展打包，不在运行时加载远程代码。Manifest 的 `wasm-unsafe-eval` 仅允许 WebAssembly 编译。
- `src/local/catalog.json` 固定 Mozilla Remote Settings 模型目录中的语言方向、版本、官方附件 URL、大小与 SHA-256。运行时无需访问模型目录。更新记录时需同时核对模型、词表和 shortlist，并使用真实模型验证运行库兼容性。
- OCR 与翻译复用同一个运行文档：Chrome / Edge 使用 offscreen，Firefox 使用后台事件页内的隐藏 iframe。翻译引擎仅在有请求且模型就绪时创建独立 Worker，串行处理任务，切换模型路线时释放旧 Worker，空闲 60 秒后释放运行内存。
- Cache Storage 按文件摘要保存模型与 1 MB 续传片段。网络请求省略凭据；下载、离线导入和推理读入均校验 SHA-256。写操作使用 Web Locks 避免跨设置窗口冲突，清理翻译缓存不影响模型。
- `npm test` 覆盖没有隐式下载、下载中断与续传、服务器忽略 Range、已完成文件复用、损坏文件拒绝、离线导入、共享文件保留、语言映射、英语中转、自动检测失败提示与单线程限制。
- `npm run test:local` 使用可选的 Playwright 与 Chromium 加载真实 MV3 扩展，默认从官方 CDN 下载约 51.9 MB 的英译中模型，然后断网验证翻译、自动语言识别、模型持久化和删除。支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`；`LOCAL_MODEL_FIXTURE_DIR` 可指向事先保存的模型文件目录，此时仅在临时测试构建中将该模型的下载地址改为本地 HTTP 服务器，实际制造断流并验证 Range 续传，随后验证断网翻译和离线导入。生产源码、模型字节、校验值与推理引擎均保持原样。报告与截图保存在 `.npm-cache/local-translation/`。
- 单元测试不衡量模型质量。真实模型回归至少检查英译中；其他方向、英语中转及低内存设备仍需人工比较质量、速度和资源占用。

### PDF 排版回归

复杂 PDF 的浏览器回归样本、执行方式和覆盖边界见 [PDF 排版回归](pdf-regression.md)。

`src/pdf/document.ts` 在全篇解析后识别参考文献区域、跨页续接和后续章节，按栏位置保留条目而不跳过同页正文；目录标题不启动文献区域。文内定义的缩写用于表格标识保护和翻译上下文，图编号、统计数值及网址通过已有占位符校验与恢复。正文分组按主要字体和实际字距处理两端对齐、行内引用及断词，图例标识单独成块。排版在独立测量节点中试排候选字号，避免 Firefox 复用旧编辑节点的字体度量；使用放大的内部坐标减少小字号度量误差，并设置自动缩字下限及溢出提示。

`src/pdf/font-control.ts` 在首次导出时展示字体选择弹窗，通过下载按钮旁的扳手提供后续安装入口。拒绝安装后，本次工作区内使用图像导出，不重复提示；安装后使用可搜索导出。`src/pdf/font-store.ts` 仅在用户确认后下载固定版本的官方 Noto Sans CJK Regular OTF 数据，校验大小与 SHA-256，使用独立 Cache Storage 保存；Web Locks 串行化安装与删除，失败或取消不会提交缓存。读取时重新校验，损坏数据会被丢弃。字体不随扩展分发；来源、完整字符覆盖摘要和 SIL OFL 许可证位于 `public/pdf-fonts/`。

`src/pdf/vector-export.ts` 使用 PDF 内容流词法分析移除被替换的原文，保留路径和图像，按预览位置嵌入可搜索文字，仅嵌入当前文档所需字形。未翻译的整页复制原页，保留片段与公式保留外观并附搜索文字；不适合安全重写的页面使用预览图像和文字层。未安装字体时，`buildRasterPdf` 使用图像导出，不加载字体处理模块，也不采集文字导出场景。

正常构建与单元测试无须下载完整字体。`tests/fixtures/pdf-export-font.otf` 是小型测试字形子集，不随扩展分发；需要复现时，在独立 Python 环境安装 `build/pdf-fonts/requirements.txt`，运行 `python build/pdf-fonts/build.py`。`--source=<官方 OTF 路径>` 可复用已有下载。测试覆盖字体选择、跳过后安装、失败重试、取消、校验、缓存复用，以及多语言文字导出与提取。

构建后运行 `npm run test:pdf:academic`、`npm run test:pdf:academic:edge` 或 `npm run test:pdf:academic:firefox`。测试使用独立浏览器和本地模拟服务，检查参考文献、缩写、公式、排版、真实下载和文字提取，同时验证跳过安装时无字体请求、扳手安装及缓存复用。字体默认使用测试子集；`PDF_FONT_FIXTURE=<完整官方 OTF 路径>` 可验证完整字体。仅隔离测试构建替换下载地址与校验值，生产文件保持官方 pin。`--file=<本地论文路径>` 可补充真实文档回归，不上传文件。报告和截图位于 `.npm-cache/pdf-academic/<浏览器>/`，支持 `PLAYWRIGHT_MODULE`、`CHROME_TEST_BROWSER`、`EDGE_TEST_BROWSER` 和 `FIREFOX_BINARY`。

构建后运行 `npm run test:pdf-scope` 可验证阅读范围调度。需要可选的 Playwright 与 Chromium，支持以下 GitHub 排版测试相同的环境变量。测试加载真实扩展，使用本地 40 页 PDF 和模拟翻译服务，验证选择文件、拖放、输入地址及切换文档后的默认自动翻译、滚动自动补译、快速跳页、重叠范围与手动编辑保留、设置切换，以及下载前补全全文翻译、直接下载与重复导出复用。手动调度与直接下载场景显式使用 `translate=0` 隔离自动启动。`tests/pdf-download.test.ts` 另覆盖切换语言、空白页、翻译失败或响应不完整后的下载拦截与重试，以及切换文档时取消下载。报告保存在 `.npm-cache/pdf-scope/`。

### GitHub 代码注释排版回归

安装可选的 Playwright 与 Chromium 后运行 `npm run test:github-code`。测试使用本地代码视图样本，不访问 GitHub 或翻译服务，覆盖普通行、固定位置行和旧版表格，以及两种窗口宽度、三种显示模式、加载占位、长译文横向滚动和清除还原。所有阶段都要求代码行位置与行号保持对齐，译文字形不能跨入下一行。

可通过 `PLAYWRIGHT_MODULE` 指定外部 Playwright 的 `index.mjs`，通过 `PDF_TEST_BROWSER` 指定现有 Chromium 或 Edge 的可执行文件；测试报告保存在被 Git 忽略的 `.npm-cache/github-code-comments/`。
