# WuPage Translator

A Manifest V3 browser extension for one-click page translation. The first version targets Chrome and Edge.

## Features

- One-click full-page translation from the popup.
- Bilingual rendering that keeps the original text and inserts translations inline.
- Built-in no-key web provider: Google Web Translate.
- Built-in Microsoft Translator provider.
- Built-in Google Cloud Translation Basic provider.
- Optional OpenAI-compatible LLM provider with configurable `baseURL`, API key, model, and prompt.
- Generic HTTP template provider for free translation APIs.
- Local translation cache keyed by provider, target language, and source text.
- No hosted proxy. Requests are sent directly from the extension to the configured provider.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Load the extension from `dist/` in `chrome://extensions` or `edge://extensions` with developer mode enabled.

## No-Key Web Providers

These providers use web translation endpoints similar to the approach used by projects such as PowerTranslator. They do not need an API key, but they are unofficial and can be rate-limited, blocked, or changed by the vendor.

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
