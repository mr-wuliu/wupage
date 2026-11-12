# 代理工作约定

本文件保存仓库级代理规则与发布上下文，随项目维护。密钥、机器专属配置和临时状态不得写入此文件。

## 远程操作约定

- 修改完成后先在本地验证，等待用户明确确认后再推送到远程、创建或合并 PR。不要将先前某次推送或合并的授权自动延续到后续修改。

## 文档约定

- README 面向扩展使用者，采用使用手册文风，说明安装、操作、限制和故障排查。
- 截图使用简洁的模式与语言标注，不复述用户要求或使用对话式引导。
- docs/development.md 保留源码构建、项目结构和验证说明。
- 发布流水线、商店自动提交、凭据配置及重试流程作为代理上下文保留在本文件中，不写入 README 或开发文档。

## 图标约定

- 界面通用图标统一使用 [Nieobie/game-icon-pack](https://github.com/Nieobie/game-icon-pack)，复用 `src/shared/ui-icons.ts` 和本地已收录的 SVG。
- 静态界面使用 `data-wupage-icon`，动态控件使用 `uiIconMarkup`；CSS 图标使用 `uiIconUrl`。不要用 Unicode 字符或手绘图形替代已有图标。

## 自动化实现位置

以下为现有实现的操作背景，具体行为以 .github/workflows/release.yml、.github/workflows/publish-edge.yml、.github/workflows/publish-firefox.yml 及对应的 scripts/publish-*.py 为准。

PDF 的无网络样本验证 `npm run test:pdf:quality -- --profile=smoke` 同时纳入 PR 检查与标签发布，失败时不得继续打包发布。`.github/workflows/pdf-regression.yml` 提供手动整批 PDF 验证，支持标准、压力和完整矩阵，下载公开原文并验证固定 SHA-256。报告单列正常排版、安全拦截和失败；压力测试的安全拦截不得当成保持版式导出成功。上传的验证证据仅包含报告、截图与日志，不上传第三方 PDF、浏览器资料目录或完整字体。

## 发布流程

推送 `v*` 标签会触发 GitHub Actions：校验 `package.json`、`package-lock.json` 与扩展 Manifest 的版本，执行类型检查和测试，构建扩展，并发布 ZIP。Release 不再附加独立的 `.sha256` 文件，校验值使用 GitHub 为每个附件生成并显示的 SHA-256 digest。

商店自动提交策略由 `scripts/publish-policy.py` 决定：仅稳定的 `v<major>.<minor>.0`（例如 `v1.4.0`、`v2.0.0`）自动调用已配置的 Edge、Firefox 商店工作流。补丁版本（例如 `v1.3.1`）仍构建全部安装包、创建 GitHub Release 并同步网站，但跳过自动商店提交；预发布版本也不自动提交。需要提交补丁版本时，在对应商店工作流的 **Run workflow** 中手动指定已发布标签；Firefox 需取消 `dry_run` 才实际提交。手动入口不受自动策略限制。

Chrome 与 Edge 共用 `npm run build` 生成的 Chromium MV3 构建（`dist/`），分别发布 `wupage-<version>-chrome.zip`、`wupage-<version>-edge.zip`。Chrome ZIP 保留固定公钥；`scripts/package-edge.py` 从 Chrome ZIP 生成 Edge ZIP，仅移除 Manifest 的 `key` 和 `update_url`，其余资源保持一致。Edge 商店拒绝 `key` 字段，其商店 ID 及更新由商店管理。两者 ZIP 根目录均为 Manifest 所在目录，不含 source map；Edge 商店提交流程仍读取原始 `edge.zip`，上传前拒绝上述字段。

三个浏览器安装 ZIP 均须小于 10,000,000 字节，发布流水线在上传前检查。PDF 完整导出字体是可选数据，仅在用户确认后从固定版本的 Noto 官方地址下载并校验；不得重新将完整字体加入 `public/`。未安装字体时仍可导出图像版 PDF。

扩展安装包只能有根目录的一个 `manifest.json`。资源目录内的来源说明或数据清单须使用其他文件名，例如 `pdf-fonts/font-metadata.json`；Edge 会将嵌套的同名文件判为无效扩展包。`tests/extension-package.test.ts` 检查公共资源目录及 PDF 字体来源校验，Edge 提交脚本也会在上传前拒绝重复清单。

稳定版的三个版本号必须保持一致。以 `v1.1.0` 为例：

```bash
npm version 1.1.0 --no-git-tag-version
# 同步更新 public/manifest.json 后提交版本变更
git tag v1.1.0
git push origin main v1.1.0
```

预发布版本需要在 Manifest 中使用 Chromium 接受的纯数字版本，并通过 `version_name` 暴露 SemVer 标签：

```json
{
  "version": "1.1.0.1",
  "version_name": "1.1.0-beta.1"
}
```

带预发布后缀的标签会自动创建 GitHub Prerelease。成功发布后，工作流还会触发项目网站的版本同步。

网站同步兼容旧版固定版本文案与新版 `releases/latest` 下载入口。页面已使用最新版链接且没有固定版本或安装包名时，无需改写网页，同步正常结束。

### 独立 Chromium CRX 与自动更新

- `build/chromium-signing.json` 固定独立分发的公钥、扩展 ID 和更新地址。普通 Chromium 构建在 Manifest 中写入该公钥，以固定解压加载时的 ID；Firefox 不包含此字段。共享构建和商店 ZIP 不包含自托管 `update_url`。
- GitHub Actions Secret `CRX_PRIVATE_KEY` 保存对应的 PEM 私钥。正式发布前必须配置；缺失或与公钥不符时打包失败。私钥只保存在仓库外的安全位置和 Secrets 中，不得提交、附加到 Release 或输出到日志，也不得在每次发布时重新生成。`*.pem`、`*.key` 和 `release/` 已排除出 Git。
- `scripts/package-crx.py` 使用 Python 标准库与 OpenSSL，按 Chromium CRX3 格式签名，生成 `wupage-<version>-chromium.crx`。只有签名包内加入 `update_url = https://wupage.mrwuliu.top/updates/chromium.xml`；CRX 同样小于 10,000,000 字节，禁止嵌套 Manifest、私钥文件、符号链接和 source map。
- 所有稳定版本（含补丁版）额外发布 `chromium.xml`，包含固定 ID、数字版本、对应 GitHub Release CRX 地址、大小及 SHA-256。预发布版可生成测试 CRX，但不生成稳定更新清单，也不修改网站。
- `scripts/prepare-web-sync.py` 从 GitHub Release API 选择 Chrome ZIP、CRX 和 XML；`scripts/sync-web.py` 对照固定 ID、版本、下载地址与 GitHub 附件 digest 校验后，将 XML 写入网站仓库的 `updates/chromium.xml`。重跑旧标签不回退现有更新清单；旧 Release 没有签名产物时仅兼容同步原有下载文案。网站同步按串行任务执行，提交后沿用网站现有部署工作流。
- 网站构建须将 `updates/chromium.xml` 复制到公开资源目录，响应类型为 `application/xml; charset=utf-8`，缓存为 `public, max-age=300, must-revalidate`。首个签名版本发布前，清单返回 `noupdate`，不得填入不存在的 CRX 地址。
- 固定 ID 和更新地址不能绕过浏览器安装政策。Windows/macOS 普通 Chrome 继续提供解压安装；解压安装仍需手动更新。首次切换到固定 ID 前提示导出设置，避免将其描述为旧 ID 的无缝迁移。
- 验证命令仍为 `python -B -m unittest discover -s tests -p 'test_publish_*.py'`，其中 CRX 测试使用临时测试密钥，不使用发布私钥、不访问商店。

### Firefox 构建

`npm run build:firefox` 从共享 Manifest 生成 `dist-firefox/`，最低 Firefox 154。`browser_specific_settings.gecko.id` 固定为 `wupage@mr-wuliu.github.io`，正式提交 AMO 后不得随意变更。数据传输声明包含 `websiteContent` 和 `authenticationInfo`，后者对应用户配置后发送给服务商的 API 凭据；功能的数据处理行为变化时须同步检查声明。

标签发布会同时生成 `wupage-<version>-firefox.zip`、`wupage-<version>-firefox-source.zip`。源码包由 `scripts/package-firefox-source.py` 从指定 Git 提交生成，并附英文构建与审核说明；不包含依赖目录、测试资料目录和凭据。GitHub Release 中的 Firefox ZIP 未经 Mozilla 签名，不等同于可长期安装的商店版本；正式安装和更新通过 AMO 分发。

### 自动同步到 Firefox Add-ons（AMO）

首次提交仍在 [AMO 开发者中心](https://addons.mozilla.org/developers/) 完成，首版通过后由自动流程提交后续正式版。使用 Mozilla 官方 [Add-on API v5](https://mozilla.github.io/addons-server/topics/api/addons.html) 和 [JWT 认证](https://mozilla.github.io/addons-server/topics/api/auth.html)，不创建新的商店条目，不修改简介、截图或许可证。

在 [AMO API 凭据页面](https://addons.mozilla.org/developers/addon/api/key/) 创建个人 API 凭据，在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `AMO_ADDON_ID` | `wupage@mr-wuliu.github.io`，与 Firefox Manifest 的 Gecko ID 一致；配置后启用次版本 / 主版本正式版自动提交 |
| Secret | `AMO_JWT_ISSUER` | AMO 显示的 JWT issuer / API key |
| Secret | `AMO_JWT_SECRET` | AMO 显示的 JWT secret / API secret |

- 符合自动提交策略的 GitHub Release 创建后，Firefox 工作流与 Edge 提交、网站同步分别执行；某一个失败不阻止其他流程。未配置 `AMO_ADDON_ID` 时跳过自动提交；配置后缺少密钥会明确报错。预发布版本不提交商店。
- 工作流直接下载已有 Release 的 Firefox ZIP、源码 ZIP，不重新构建或重新打包。`scripts/publish-checksums.py` 从 GitHub Release API 的附件 digest 生成仅供本次运行使用的临时校验文件；缺失或无效的 SHA-256 digest 会中止提交，不依赖 Release 中的 `.sha256` 附件。检查 SHA-256、Manifest 的版本和 Gecko ID、源码内三个版本及根包版本，以及 `SOURCE_REVISION.txt` 与标签实际 Git 提交的一致性。
- 提交前通过认证 API 检查现有条目及全部公开渠道版本（包括待审版本）。同版本已公开或待审且有源码时直接跳过，不覆盖文件或修改审核；其他待审版本、已拒绝/禁用版本、缺源码或版本倒退会要求人工处理。首次审核尚未通过时不会提交新版本。
- 上传 ZIP 后等待 AMO 自动校验通过，再在同一次创建版本请求中上传配套源码和英文审核备注。更新沿用上一版许可证，商店元数据仍在 AMO 后台维护。密钥始终只放在 GitHub Secrets，不得写入仓库、日志或审核备注。
- AMO 的 `approval_notes` 最多 3000 字符。脚本保留版本、源码提交号及 `FIREFOX_BUILD.txt` 位置，超长时按完整行缩短备注；源码包中的完整构建与审核说明保持原样，不因此重打发布产物。
- 在 GitHub **Actions → Publish to Firefox Add-ons → Run workflow** 输入已有正式版标签可单独试跑或重试。`dry_run` 默认勾选：只验证发布产物；如果两项密钥都存在，还会检查账号权限和现有版本，全程不上传、不修改 AMO。未配置密钥时试跑成功仅表示本地产物检查通过。
- 确认后取消 `dry_run` 才会实际提交；符合自动提交策略的正式版标签触发的调用使用实际提交模式。提交请求超时后，先在 AMO 后台确认是否受理；脚本不会自动重发写入请求。重跑会先检查同版本是否已经存在。
- 工作流成功表示已提交或同版本已存在，不代表审核通过。Mozilla 审核、签名和商店上线仍需等待；工作流不会长时间等待人工审核，也不会从签名文件重新生成 Release 的未签名 ZIP。
- 本地验证发布脚本：`python -B -m unittest discover -s tests -p 'test_publish_*.py'`。校验使用模拟网络，不会接触真实商店。

### 自动同步到 Microsoft Edge Add-ons

项目支持通过 [微软官方的 Edge Add-ons Publish API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api) 自动上传 Release ZIP 并提交审核。扩展需要已在商店完成首次发布。

首次配置：

1. 登录 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)，在 **Microsoft Edge → Publish API** 中启用使用 API Key 的新体验，并创建凭据，获取 **Client ID** 与 **API Key**。
2. 打开扩展概览，在 **Extension identity** 中复制 **Product ID**。这是 Partner Center 中的 GUID，不是商店详情页中由字母组成的扩展 ID。
3. 打开 GitHub 仓库 **Settings → Secrets and variables → Actions**，添加以下配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `EDGE_PRODUCT_ID` | 扩展的 Product ID；配置后启用次版本 / 主版本正式版自动提交 |
| Secret | `EDGE_CLIENT_ID` | Publish API 提供的 Client ID |
| Secret | `EDGE_API_KEY` | Publish API 提供的 API Key |

推送符合自动提交策略的正式版 `v<major>.<minor>.0` 标签后：工作流创建 GitHub Release 后，直接调用商店发布工作流，下载该 Release 的原始 ZIP，通过 `scripts/publish-checksums.py` 从 GitHub 附件 digest 生成临时 SHA-256 校验文件，验证校验和及 Manifest 版本，上传 ZIP，等待上传成功，再提交微软审核并检查提交结果。使用的是 v1.1 的 API Key 认证（`Authorization: ApiKey ...`、`X-ClientID`），无需配置旧版 Access Token URL 或 Client Secret。

- 未配置 `EDGE_PRODUCT_ID` 时自动跳过商店提交；配置后缺少凭据会明确报错。预发布版本不提交商店。
- 商店发布与网站同步分别执行；GitHub Release 已创建时，网站同步失败不会阻止商店提交。
- 自动化成功表示已提交审核，上线仍需等待微软审核及商店分发。已有版本正在审核时，微软可能拒绝新的提交；处理完成后再重试。
- 如果仅商店提交失败，可在 GitHub **Actions → Publish to Microsoft Edge Add-ons → Run workflow** 中输入已有正式版标签，单独重试，无需重建 Release。若之前提交超时，请先在 Partner Center 确认是否已经受理。
- API Key 有有效期，请按 Partner Center 显示的到期时间更新 `EDGE_API_KEY`；Client ID 如有变化也需同步更新。商店简介、截图等元数据仍需在 Partner Center 维护。
