<div align="center">
  <img src="public/icons/icon-128.png" width="96" height="96" alt="WuPage Translator" />
  <h1>WuPage Translator</h1>
  <p>适用于 Microsoft Edge、Chrome 和 Firefox 的网页、视频字幕、图片与 PDF 翻译扩展。</p>
  <p>支持双语对照、划词查词、暂停画面翻译和 PDF 译文编辑，可选在线服务或本地翻译。</p>
  <p>
    <a href="https://microsoftedge.microsoft.com/addons/detail/wupage-translator/ophhojnppohaklhcdaheplkodopmplfg">Microsoft Edge 插件商店</a> ·
    <a href="https://addons.mozilla.org/zh-CN/firefox/addon/wupage-translator/">Firefox Add-ons</a> ·
    <a href="https://github.com/mr-wuliu/wupage/releases/latest">下载发布包</a> ·
    <a href="https://wupage.mrwuliu.top/">项目主页</a> ·
    <a href="https://github.com/mr-wuliu/wupage/issues">问题反馈</a> ·
    <a href="PRIVACY.md">隐私政策</a> ·
    <a href="LICENSE">GPL-3.0</a>
  </p>
  <p>
    <a href="https://github.com/mr-wuliu/wupage/releases"><img src="https://img.shields.io/github/v/release/mr-wuliu/wupage?include_prereleases&sort=semver" alt="GitHub Release" /></a>
  </p>
</div>

[功能一览](#功能一览) · [效果预览](#效果预览) · [安装](#安装) · [翻译服务](#翻译服务) · [常见问题](#常见问题) · [反馈与交流](#反馈与交流)

## 功能一览

界面默认跟随浏览器，支持简体中文和英文，其他语言使用英文。可在「设置 → 通用 → 界面语言」切换，点击「保存」后刷新已打开的网页和 PDF。要更改译文的语言，请在弹窗或设置中选择「目标语言」。

| 功能 | 简要说明 |
| --- | --- |
| 网页全文 | 翻译正文、动态加载和嵌入内容，支持恢复原文 |
| 段落翻译 | 桌面端开启后按住 `Ctrl` 点击段落；触屏端使用「点选段落」，完成一次后自动退出；再次翻译同段可恢复原文 |
| 双语显示 | 译文替换、原色对照（默认）、双色对照，可随时切换 |
| 划词翻译 | 选中文字后点击入口查词或翻译；输入框支持翻译所选文字并一键替换；支持有道 / Bing 词典及中文拼音、释义 |
| 自动翻译 | 按网站或页面语言自动翻译，默认关闭 |
| 翻译区域 | 按网站和 CSS 选择器补译漏译区域，或保留指定区域原文；预置可编辑的 X 侧边导航规则 |
| 视频字幕 | 点击播放器上的「译」翻译已有字幕，支持双语显示与 SRT / VTT 导入；不支持无字幕听译 |
| 暂停画面翻译 | 点击播放器上的屏幕图标，识别并翻译画面文字，需开启视频字幕及图片翻译，并安装内置 OCR 模型或配置自定义 OCR 服务 |
| 图片翻译 | 安装内置 OCR 模型或配置自定义 OCR 服务并开启功能，点击图片旁的「译」原位显示译文 |
| PDF 阅读 | 打开后自动翻译当前页附近内容，支持原译对照及译文编辑；需有文本层 |
| PDF 导出 | 下载前补全全文翻译；可导出图像版，或安装可选字体后导出可搜索文字 |
| 悬浮球与右键菜单 | 在网页内翻译、恢复原文或切换设置；右键翻译需先开启 |
| 外观与菜单 | 明暗主题、自定义配色与颜色透明度、悬浮球透明度，以及菜单入口的显示和排序 |
| 快捷键 | 默认 `Alt+Shift+Y` 翻译全文；按键和开关可在设置中修改 |
| 使用统计 | 查看用量、成功率、响应时间与接口返回的 Token，默认关闭，仅保存在本机 |

外观设置中，先复制内置方案即可自定义配色；已有自定义方案可在方案选择器下方直接修改名称。点击颜色右侧的圆形棋盘格按钮可调节该颜色的透明度，100% 为完全不透明，0% 为完全透明，默认均为 100%。颜色透明度与悬浮球整体透明度分别设置，修改后点击「保存」生效。

在「外观 → 配色与外观 → 译文与段落」中关闭「显示段落高亮」，可隐藏段落边框与底色，段落翻译操作保持可用。此开关适用于所有配色方案，修改后点击「保存」生效。

## 效果预览

**译文替换 · 日语 → 简体中文**

| 原文 | 译文 |
| --- | --- |
| ![日语原文页面](docs/example/capture_madoka_raw.png) | ![译文替换模式下的简体中文译文页面](docs/example/capture_madoka_trans.png) |

**PDF 双栏对照 · 英语 → 简体中文**

![PDF 课件翻译：左侧英文原文，右侧简体中文译文](docs/example/PDF-ppt-trans.png)

**外观配色 · 浅色 / 深色**

![樱粉、晴蓝、素白、玫夜、深海、墨黑六套配色预览](docs/example/appearance-schemes.png)

## 安装

### Microsoft Edge

从 [Microsoft Edge 插件商店](https://microsoftedge.microsoft.com/addons/detail/wupage-translator/ophhojnppohaklhcdaheplkodopmplfg) 点击「获取」安装，并将 WuPage 固定到工具栏。

### Firefox

从 [Firefox Add-ons](https://addons.mozilla.org/zh-CN/firefox/addon/wupage-translator/) 安装，需要 Firefox 154 或更新版本。Releases 中的 Firefox ZIP 未经 Mozilla 签名，仅供临时测试。

### Chrome / Edge 手动安装

1. 从 [Releases](https://github.com/mr-wuliu/wupage/releases/latest) 下载 `wupage-<version>-chrome.zip` 或 `wupage-<version>-edge.zip` 并解压。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启「开发人员模式」。
3. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的解压目录。

手动更新时，用新版文件替换原目录内容，再到扩展管理页重新加载。安装或更新后，刷新已打开的网页。

### 独立 CRX 安装包

Releases 中的 `wupage-<版本>-chromium.crx` 使用固定密钥签名，适用于允许安装外部 CRX 的 Chromium 浏览器。成功安装该 CRX 后，浏览器会通过项目网站检查正式版更新，下载对应的签名包；预发布版不推送到此更新渠道。解压后加载的 ZIP 仍需手动更新。

独立签名包的扩展 ID 固定为 `fgeedjpifhmkdehbgdmngbehdfcflblc`，可在扩展管理页核对。更新入口为[正式版更新清单](https://wupage.mrwuliu.top/updates/chromium.xml)，浏览器仅安装版本号更高且签名一致的更新。首个签名正式版发布前，清单返回 `noupdate`，表示当前没有可用更新。

Windows、macOS 上的普通 Chrome 限制安装商店外的 CRX，请使用上面的解压加载方式。其他 Chromium 浏览器是否支持 CRX 安装与自动更新，以浏览器及设备策略为准。Edge 和 Firefox 商店版通过各自商店更新。

首次从旧版解压安装切换时，扩展 ID 可能变化。请先导出设置，再安装新版并导入；需要恢复 API 凭据时，导出时勾选「包含密钥」。新旧扩展同时存在时，只启用其中一个。设置备份不包含翻译缓存及模型。

## 翻译服务

在「设置 → 翻译服务」配置并保存，在弹窗中选择实际使用的服务。

| 服务 | 使用条件 |
| --- | --- |
| Microsoft、Google、腾讯、Yandex、火山 | 预置无需密钥的免费服务，也可切换为自备凭据的 API 模式 |
| MyMemory | 匿名免费服务或 RapidAPI，适合少量文本 |
| 豆包（实验性） | 在同一浏览器中登录豆包，无需 API Key；仅支持 Chrome / Edge |
| DeepL | DeepL API Key；按密钥自动选择官方 Free / Pro 地址，也可填写兼容接口地址 |
| Index-Translate | 连接官方本地桥接或自行部署的 OpenAI 兼容服务，支持自定义模型和可选密钥 |
| DeepSeek / Zhipu GLM | 对应平台的 API Key 和模型 |
| OpenAI / Anthropic 兼容服务 | 自定义服务地址、模型、密钥和提示词；OpenAI 兼容服务可连接 Ollama 等本地接口 |
| HTTP 模板 | 自定义请求地址、参数与响应路径 |
| Firefox 本地翻译（实验） | 使用 Bergamot 引擎，Chrome / Edge 也可使用；需先下载或导入语言模型，准备完成后可离线翻译 |

本地模型在该服务的设置中下载；离线安装可展开「网络不畅或离线安装」，保存所选方向的全部文件后点击「离线导入」。Chrome / Edge 请直接点击扩展页面中的文件链接；将原始链接复制到地址栏可能被 Mozilla 下载服务拒绝（HTTP 406），也可改用 Firefox 下载后导入。

免费服务可能受限流、地区和接口变更影响。服务持续失败时需手动重试或切换，不会自动转发到其他服务；支持语言、额度与费用以服务商为准。

本地翻译模型每个语言方向约 35–55 MB，非英语之间的翻译可能需要经英语中转的两个方向。选择服务不会自动下载模型；缺少模型时按设置页提示安装。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 点击翻译无响应 | 安装或更新后刷新网页；浏览器内置页、扩展内部页和商店受限页面无法翻译 |
| 服务报错或限流 | 检查网络、密钥、登录状态及额度，在弹窗的 Debug 面板查看原因后重试 |
| 部分内容未翻译或排版异常 | 在「设置 → 翻译区域」检查保留原文规则，或添加补译规则。填写网站和 CSS 选择器后保存，例如使用 `[role="dialog"] .field-label` 补译弹窗标签。规则在网页或段落翻译时生效，两种规则重叠时保留原文优先。输入值、编辑区和隐藏内容会跳过 |
| 图片或画面识别失败 | 使用内置 OCR 时确认模型已安装；使用自定义 OCR 时先测试识别，检查地址、模型名及返回的坐标。确认图片可访问且视频画面无遮挡；复杂背景、艺术字和受保护视频可能无法处理 |
| 本地 PDF 无法打开 | 在扩展详情中开启文件访问权限，或直接在 PDF 工作区选择、拖入文件；扫描版 PDF 暂不支持 |
| PDF 部分段落翻译失败 | 已完成译文会保留，未完成位置暂时显示原文；点击本页「补译未完成段落」。持续连接中断时会暂停后续请求，检查连接后可用顶部翻译按钮恢复 |
| 导出的 PDF 无法搜索文字 | 图像版导出不含可选文字，可安装完整字体后重新导出；若出现缺字降级提示，相关页面可能只支持部分文字搜索 |
| PDF 译文块出现红框，无法导出 | 调整红框译文块的大小、字号或文字后再下载，并检查相邻译文块是否重叠 |
| PDF 导出字体下载失败 | 检查 `raw.githubusercontent.com` 的连通性，或在安装窗口手动下载指定字体并从文件安装；也可继续导出图像版 PDF |
| 找不到功能入口 | 在「设置 → 外观 → 菜单功能」添加入口或恢复默认布局 |

## 隐私说明

翻译服务只接收待翻译文字及其所需凭据，图片、视频画面和 PDF 文件不上传给翻译服务。默认 OCR 在本机识别；主动选择自定义 OCR 后，图片及暂停视频画面发送到指定 OCR 服务。本地翻译在设备上处理文本，划词查词仍使用在线词典。设置、凭据、缓存和可选统计保存在当前浏览器，WuPage 不提供翻译代理或分析服务。详见[隐私政策](PRIVACY.md)。

弹窗中的「清除缓存」仅清理翻译结果；OCR 模型、本地翻译模型、PDF 字体和使用统计需在各自入口单独删除。

## 反馈与交流

通过 [Issues](https://github.com/mr-wuliu/wupage/issues) 提交问题，附上浏览器与扩展版本、翻译服务、复现步骤和脱敏后的 Debug 错误信息。

QQ 开发交流群：**582857596**。

<img src="docs/communicate/qrcode_1793126599797.jpg" width="320" alt="WuPage 开发交流群二维码，群号 582857596" />

源码构建、项目结构和验证说明见[开发指南](docs/development.md)。

## 许可证

WuPage 的原创代码采用 [GNU General Public License v3.0 only（GPL-3.0-only）](LICENSE)。允许使用、修改和商业分发；分发本项目或衍生版本时，须按 GPL-3.0 向接收者提供完整的对应源码，并保留版权和许可声明。软件按现状提供，不作任何担保，具体条款以许可证全文为准。

## 致谢

界面通用图标采用 Nieobie 的 [Game Icon Pack](https://github.com/Nieobie/game-icon-pack)（CC0 1.0）。
