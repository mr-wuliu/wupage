# PDF 排版验证

[返回开发指南](development.md#验证改动)

用于修改 PDF 提取、排版、公式保护或导出逻辑后，检查真实扩展的完整处理流程。样本来源、抽查页及保留区域由 [pdf-corpus.json](../tests/fixtures/pdf-corpus.json) 统一维护。

## 运行

先按[开发指南](development.md#环境搭建)安装项目依赖，再准备可选的浏览器测试环境：

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run build
npm run test:pdf -- --download
```

`--download` 在本地缺少样本时下载公开 PDF；已有缓存后可省略。测试使用独立浏览器资料和本地模拟翻译服务。

`drg` 样本逐像素检查第 8–10 页的公式和第 11 页的双栏参考文献。第 10 页分别检查式 (18)、(19)，第 11 页的检查包括第一条编号和右栏开头的续排条目。若出版方下载页要求浏览器验证，可手动下载原始英文 PDF，保存为 `.npm-cache/pdf-corpus/drg.pdf`，再运行 `npm run test:pdf -- --ids=drg`。

学术 PDF 验证也支持 `--corpus=drg`，复用缓存样本和公式保留区域。例如 `npm run test:pdf:academic:firefox -- --corpus=drg` 可在 Firefox 中检查预览、公式像素及可搜索导出。

增加 `--anonymize-fonts` 会再检查一份隐藏字体名称的样本，验证公式保护不依赖出版方字体名。测试只修改本地副本的字体名称，保留嵌入字体与页面内容，并核对原公式区域的渲染哈希。示例：`npm run test:pdf:academic:firefox -- --corpus=drg --anonymize-fonts`。

公式识别综合使用上下标位置、相邻表达式、分数线、当前页字体的用途及异常编码证据，已知数学字体作为补充。检测到异常编码的文本片段保留原图，不尝试按字符猜测数学含义。含文字的行内分式也按排版结构保护，并检查其分子、分母没有进入翻译请求。分段公式根据左侧关系式、括号和对齐的多行分支整体保护，包括其中的函数名与条件文字。单元测试同时覆盖普通正文、连字、小型大写标题、表格和日期，防止保护范围扩散。

可通过 `PLAYWRIGHT_MODULE` 指定已有 Playwright 的 `index.mjs`，通过 `PDF_TEST_BROWSER` 指定 Chromium 或 Edge 的可执行文件。

## 常用参数

参数放在 `npm run test:pdf --` 后，按需要组合。

| 参数 | 用途 |
| --- | --- |
| `--ids=admm,pmlr` | 仅检查指定样本，标识见样本清单 |
| `--file="/absolute/path/paper.pdf"` | 加入本地问题文档 |
| `--expanded` | 使用较长模拟译文检查排版 |
| `--device-scale=1.25` | 检查屏幕缩放对显示与导出的影响 |
| `--auto-open` | 通过 URL 打开文档并自动开始翻译 |
| `--repeat=3` | 重复操作，检查译文与缓存复用 |
| `--minimum-font=48` | 在测试资料中模拟浏览器最小字号限制 |
| `--damage-markers` | 模拟公式标记损坏，检查恢复流程 |

例如，使用已缓存的讲义检查缩放、自动打开与重复翻译：

```bash
npm run test:pdf -- --ids=admm --device-scale=1.25 --auto-open --repeat=3
```

## 翻译任务与超时

修改 PDF 请求、取消任务或后台连接时，运行对应浏览器的生命周期验证：

```bash
npm run build
npm run test:pdf-lifetime:edge
npm run build:firefox
npm run test:pdf-lifetime:firefox
```

测试生成三页 PDF，使用本地服务模拟不返回正文、延迟 35 秒回复与正常回复，检查超时后终止网络请求、失败部分重试、切换语言及离开页面时取消旧任务，并确认后台队列清空。测试会缩短阅读器的等待时间；后台单批次任务的两分钟期限、排队取消和公式标记恢复期间的取消由 `tests/pdf-translation.test.ts` 覆盖。报告保存在 `.npm-cache/pdf-lifetime/`。

`npm run test:pdf-partial:edge` 与 `npm run test:pdf-partial:firefox` 使用多段落 PDF，主动截断 HTTP 回复正文，检查成功段落立即显示、自动重试有上限、按页补译只发送缺失段落、手动修改及输入焦点保留，以及跳页后取消远处请求并优先处理新阅读页。报告与部分失败截图保存在 `.npm-cache/pdf-partial/`。

## 结果与边界

样本文件、各运行模式的 `report.json` 和对照截图保存在 `.npm-cache/pdf-corpus/`，不随源码提交。报告检查失败页、文字溢出、字号、导出页数与尺寸；部分样本还比较公式和图表区域的像素。

验证后应人工查看重点截图，并用独立 PDF 阅读器抽查导出文件。模拟译文用于重复验证流程与排版，真实服务的翻译质量和网络行为需另行检查；扫描 PDF 的 OCR 不在这组验证范围内。
