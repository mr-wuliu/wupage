# WuPage Privacy Policy

Effective date: July 18, 2026

WuPage is a Microsoft Edge and Chromium-compatible browser extension that translates webpage text using a translation provider selected and configured by the user.

## Data WuPage Processes

WuPage processes the following data only to provide its translation functionality:

- **Website content:** When the user requests a page or paragraph translation, WuPage reads the relevant text from the current webpage and sends that text to the translation provider selected by the user. This content can include text the user is viewing on the page.
- **Authentication information:** If a selected translation provider requires an API key or other authorization header, WuPage stores the credential in the browser's local extension storage and sends it only to the configured provider for authentication.
- **Extension settings:** Language preferences, provider configurations, performance settings, the floating control position, and related extension preferences are stored locally in the browser.
- **Translation cache:** When local caching is enabled, translated text is stored locally with a hash of the source text. Users can disable or clear the cache from the extension interface.
- **Debug information:** When translation tasks run, WuPage can display source text, translated text, request status, and errors in its Debug window. This information is held by the extension for troubleshooting and is not sent to the WuPage developer.

WuPage does not intentionally collect names, email addresses, health information, financial information, precise location, browsing history, or user activity for analytics, advertising, profiling, or tracking.

## How Data Is Used and Shared

WuPage has no developer-operated translation proxy or analytics server. Translation requests are sent directly from the user's browser to the translation provider that the user selects or configures. Depending on the user's configuration, that provider can be Google Web Translate, Microsoft Translator, Google Cloud Translation, Zhipu GLM, an OpenAI-compatible service, an Anthropic-compatible service, or a custom HTTP service.

Website content is shared with the selected provider solely to return the translation requested by the user. Authentication information is shared only with the corresponding provider to authorize that request. Each provider processes data under its own terms and privacy policy. Users should not translate sensitive content through a provider they do not trust.

WuPage does not sell user data. WuPage does not transfer user data for advertising, creditworthiness, lending, or any purpose unrelated to webpage translation.

## Storage and Retention

Settings, provider credentials, and optional translation cache entries are stored locally through the browser's extension storage. They remain until the user changes or clears them, resets the extension settings, clears extension data, or uninstalls WuPage. Debug task information is temporary and is discarded when the extension's background context is reset.

Provider responses and request metadata can be retained by the selected provider according to that provider's policies. WuPage does not control a provider's retention practices.

## Security

WuPage sends translation requests over HTTPS unless the user explicitly configures a custom HTTP provider with a different URL. API credentials are not included in WuPage source code and are not sent to the WuPage developer. Users are responsible for choosing trusted providers and securely configuring custom endpoints.

## User Controls

Users can:

- choose, configure, enable, disable, or remove translation providers;
- remove stored provider credentials by clearing the relevant configuration;
- disable the local translation cache or clear cached translations;
- clear displayed translations from a webpage;
- reset extension settings; and
- remove all locally stored extension data by uninstalling WuPage.

## Changes to This Policy

This policy may be updated when WuPage's data practices or features change. Material changes will be reflected in this document and its effective date.

## Contact

For privacy questions or requests, open an issue at <https://github.com/mr-wuliu/wupage/issues>.
