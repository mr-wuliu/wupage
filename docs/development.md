# 开发指南

[返回 README](../README.md)

## 开发

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

### Firefox 构建与验证

Firefox 需要 154 或更新版本。两种浏览器共用业务源码，分别生成安装目录：

```bash
npm run build          # Chrome / Edge：dist/
npm run build:firefox  # Firefox：dist-firefox/
npm run dev:firefox    # 监听修改并重新生成 Firefox 构建
```

在 `about:debugging#/runtime/this-firefox` 中临时加载 `dist-firefox/manifest.json`。源码修改后先完成构建，再点击该页的「重新载入」，并刷新普通网页。临时扩展退出浏览器后失效；正式安装需要 Mozilla 签名。

`public/manifest.json` 是共享配置；`build/manifest.ts` 生成 Firefox 的后台脚本、扩展 ID、最低版本和数据传输声明。版本号保持与共享 Manifest 一致。Firefox 154 提供 OCR 依赖的扩展沙箱；Firefox 构建把 OpenCV 内嵌的 WASM 拆成独立文件，保持字节不变，并避免单个脚本超过 AMO 的 5 MB 解析上限。

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

- 自动翻译由 `src/shared/auto-translation.ts` 归一化并匹配站点规则，`src/content/auto-translation.ts` 在前台 HTML 页面触发现有渐进翻译。语言检测仅使用本机浏览器接口；路由、配置与手动停止会使过期检测结果失效。回归覆盖域名边界、通配与路径、旧设置默认关闭、动态内容、手动停止和单页导航。
- `npm run test:auto`：构建后加载实际扩展，使用本地网页和模拟翻译服务验证规则保存、窄屏、自动触发、手动恢复原文、单页导航、目标语言跳过和异步加载的正文。报告保存在 `.npm-cache/auto-translation/`。
- 六个预置在线翻译服务通过 `serviceMode` 区分 `free`（默认）和 `api`，凭据保存在对应配置的 `api` 中。免费分支不读取或发送这些凭据；切换方式会保留已有配置。旧版内置 Azure / Google Cloud 配置在规范化设置时迁移至对应服务商，存在不同凭据时保留独立配置。火山 API 在后台通过 Web Crypto 生成 V4 签名；腾讯 API 使用 TokenHub 的翻译模型。
- `npm run test:services`：构建后加载实际扩展，以模拟网络响应验证六家服务的免费/API 切换、设置保存、凭据保留、实际请求分支和窄屏布局，不访问真实付费服务。支持 `PLAYWRIGHT_MODULE`、`PDF_TEST_BROWSER`，报告保存在 `.npm-cache/service-modes/`。
- 服务额度资料保存在 `src/shared/provider-usage.ts`，设置页在切换服务、使用方式、模型或地址时更新。维护数值时须核对所链接的官方资料并更新核对日期；匿名接口与云 API 分开，官方未公开的数字不以经验值代替。`src/options/provider-usage.ts` 单独显示插件调度设置，不能将 RPM、QPS 和并发混用。说明仅使用随扩展打包的资料，不查询账号余额或额外请求第三方接口。
- 另外预置 `tencent-transmart`、`yandex-web-translate`、`volcengine-web-translate` 与 `mymemory`。免费模式下，腾讯使用批量请求，Yandex 与火山逐项处理以保留段落对应关系；MyMemory 在本机检测源语言，并按 500 UTF-8 字节分段，保留空白、Unicode 字符、占位符及实体字面量。回归测试覆盖错误响应、额度限制、取消和旧配置兼容。
- 服务图标随扩展内联打包，弹窗、悬浮菜单和 PDF 共用带图标的服务选择器；设置页复用同一图标映射。图标来源与 MIT 许可保存在 `public/licenses/lobe-icons.txt`，显示时无需访问外部图片服务器。
- `npm run test:page`：先运行 `npm run build`，再使用可选的 Playwright 与 Chromium 加载真实 MV3 扩展。支持 `PLAYWRIGHT_MODULE` 与 `PDF_TEST_BROWSER` 环境变量。
- 使用本地页面和本地模拟翻译服务，覆盖两种窗口宽度、三种显示模式、代码占位符损坏恢复、隐藏内容与草稿排除、Ctrl 点击段落翻译、清除还原，以及动态原文更新后的迟到响应。切换显示模式不得新增翻译请求。
- 同时检查 `dist/content.js` 能作为普通脚本解析，防止公共工具被拆成模块导入而导致内容脚本无法加载。报告保存在 `.npm-cache/page-translation/report.json`。
- `npm run test:cards`：使用实际扩展和本地模拟服务，检查中英文界面下的混合语言卡片。覆盖 Flex/Grid 字段分离、标题字号与字重、作者链接、两种窗口宽度、三种显示模式和清除还原；匿名服务将整批判为目标语言时，未翻译项应独立重试。报告保存在 `.npm-cache/card-layout/`。
- `npm run test:floating`：加载实际扩展，覆盖真实指针的 500 毫秒悬停延迟、离开取消、拖动与位置保存、悬浮球和弹窗的翻译中停止、迟到响应、原译文切换与缓存复用、动态列表、状态同步、缓存清理、失败重试、Debug、设置入口、键盘操作和小窗口。报告保存在 `.npm-cache/floating-interactions/`。
- `npm run test:settings`：延迟返回设置，逐帧检查弹窗和设置页重开时的图片翻译开关；保存为开启或关闭的状态都不得闪现错误位置或启动动画。报告保存在 `.npm-cache/settings-initialization/`。
- 网页回归还包含明暗背景、现代 CSS 颜色和网页强制文字颜色下的实际颜色检查，切换原色、双色和替换模式时不得新增翻译请求。
- 翻译链路的审视结论与兼容处理边界见 [翻译系统审视](translation-review.md)。

### 图片翻译回归验证

- 本地视觉回归页：运行开发预览服务后打开 `tests/fixtures/image-preview.html`，使用固定模型结果检查覆盖、切换、缩放与内部滚动，不调用外部 API。
- `npm run test:ocr`：加载真实扩展，下载并校验公开 OCR 模型到独立测试资料目录，验证沙箱初始化、图片识别、覆盖显示、三次原译图切换、重新打开后的缓存、模型删除和设置持久化。翻译使用本地模拟服务，不使用真实 API 密钥。需要网络下载约 20.5 MB 模型及可选的 Playwright 与 Chromium；报告保存在 `.npm-cache/ocr-flow/`。
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

构建后运行 `npm run test:pdf-scope` 可验证阅读范围调度。需要可选的 Playwright 与 Chromium，支持以下 GitHub 排版测试相同的环境变量。测试加载真实扩展，使用本地 40 页 PDF 和模拟翻译服务，验证滚动自动补译、快速跳页、重叠范围与手动编辑保留、设置切换，以及导出不触发全文翻译。报告保存在 `.npm-cache/pdf-scope/`。

### GitHub 代码注释排版回归

安装可选的 Playwright 与 Chromium 后运行 `npm run test:github-code`。测试使用本地代码视图样本，不访问 GitHub 或翻译服务，覆盖普通行、固定位置行和旧版表格，以及两种窗口宽度、三种显示模式、加载占位、长译文横向滚动和清除还原。所有阶段都要求代码行位置与行号保持对齐，译文字形不能跨入下一行。

可通过 `PLAYWRIGHT_MODULE` 指定外部 Playwright 的 `index.mjs`，通过 `PDF_TEST_BROWSER` 指定现有 Chromium 或 Edge 的可执行文件；测试报告保存在被 Git 忽略的 `.npm-cache/github-code-comments/`。
