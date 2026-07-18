# WuPage Translator

A Manifest V3 browser extension for one-click page translation. The first version targets Chrome and Edge.

[Privacy Policy](PRIVACY.md)

> PDF translation is currently available as a `v1.0.0-beta.1` prerelease. It is suitable for testing, but complex documents may still require manual layout adjustments.

## Features

- One-click full-page translation from the popup.
- Dedicated PDF translation workspace with page-aligned original and translated columns.
- Open the current online PDF directly, upload a local PDF, or paste a PDF URL.
- Edit, move, resize, or remove individual translated PDF text blocks in place.
- Bilingual rendering that keeps the original text and inserts translations inline.
- Built-in no-key web provider: Google Web Translate.
- Built-in Microsoft Translator provider.
- Built-in Google Cloud Translation Basic provider.
- Optional OpenAI-compatible LLM provider with configurable `baseURL`, API key, model, and prompt.
- Generic HTTP template provider for free translation APIs.
- Local translation cache keyed by provider, target language, and source text.
- No hosted proxy. Requests are sent directly from the extension to the configured provider.

## PDF Translation (Beta)

When the active tab is an online PDF, the popup's **Translate full page** action automatically changes to **Translate PDF**. Opening it launches a dedicated workspace and starts translation immediately.

- The original document and translated result are rendered in synchronized, page-aligned columns.
- Online PDF URLs and locally uploaded PDF files are supported.
- Translated text blocks can be edited, moved, resized, or removed without changing the original column.
- Text color and placement are reconstructed from the PDF text layer where possible.

Current limitations:

- Image-only or scanned PDFs are not translated because OCR is not included yet.
- Complex tables, unusual fonts, and highly graphical layouts may need manual correction.
- Edited layouts remain in the current workspace; exporting a translated PDF is not available yet.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Load the extension from `dist/` in `chrome://extensions` or `edge://extensions` with developer mode enabled.

## Tagged Releases

Pushing a `v*` tag runs the release workflow. It checks the project, builds the extension, creates an Edge-ready ZIP with `manifest.json` at the archive root, and uploads the ZIP and its SHA-256 checksum to a GitHub Release.

Before tagging a stable release, keep the versions in `package.json`, `package-lock.json`, and `public/manifest.json` identical. For example, to publish `v1.0.0`:

```bash
npm version 1.0.0 --no-git-tag-version
# Update public/manifest.json to 1.0.0, then commit the version change.
git tag v1.0.0
git push origin main v1.0.0
```

For a prerelease such as `v1.0.0-beta.1`, use a numeric Chrome manifest version and expose the SemVer label through `version_name`:

```json
{
  "version": "1.0.0.1",
  "version_name": "1.0.0-beta.1"
}
```

Tags containing a prerelease suffix are automatically published as GitHub prereleases. The workflow publishes `wupage-<version>-edge.zip` on the matching release page; upload that ZIP directly to Microsoft Partner Center when the build is ready for wider testing.

## No-Key Web Providers

These providers use web translation endpoints similar to the approach used by projects such as PowerTranslator. They do not need an API key, but they are unofficial and can be rate-limited, blocked, or changed by the vendor.

The options page also supports custom HTTP providers and custom LLM providers using either the OpenAI Chat Completions or Anthropic Messages format. Providers can be enabled, disabled, or removed without editing extension files.

Chunk size and concurrency have global defaults. Each provider can inherit those values or override them independently. Provider concurrency is always capped by the global maximum, including when requests from different providers overlap.

- `Google Web Translate`: `https://translate.googleapis.com/translate_a/single`

## Built-In Providers

### Microsoft Translator

Use an Azure Translator resource key.

- `Endpoint`: `https://api.cognitive.microsofttranslator.com`
- `API key`: your Translator key
- `Region`: your Azure region, for example `eastasia`; leave empty only for resources that do not require a region header

The extension calls:

```text
POST /translate?api-version=3.0&to={targetLang}
```

### Google Cloud Translation

Use a Google Cloud Translation Basic API key.

- `API key`: your Google Cloud API key

The extension calls:

```text
POST https://translation.googleapis.com/language/translate/v2?key={apiKey}
```

## Optional LLM Provider

The OpenAI-compatible provider is optional. It supports OpenAI-compatible gateways such as OpenAI, DeepSeek-compatible endpoints, and other `/chat/completions` services.

## Provider Templates

HTTP templates support these placeholders:

- `{{targetLang}}`
- `{{sourceLang}}`
- `{{texts}}`
- `{{json texts}}`

The response path must resolve to an array of translated strings in the same order as the input texts.
