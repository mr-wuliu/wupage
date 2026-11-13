export const GOOGLE_TEST_KEY = "A".repeat(39);
export const GOOGLE_TEST_MODULE = "https://translate.googleapis.com/_/translate_http/_/js/k=fixture/m=el_main";

export function googleAuthResponse(url: string): Response | undefined {
  if (url.includes("/translate_a/element.js?")) return new Response(`_loadJs('${GOOGLE_TEST_MODULE}');`);
  if (url === GOOGLE_TEST_MODULE) return new Response(`({'x-goog-api-key':'${GOOGLE_TEST_KEY}'})`);
}

/** Keep provider-level mocks focused on translations, not shared key discovery. */
export function withGoogleAuth(translate: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return (url: string, init: RequestInit = {}) => googleAuthResponse(url) ?? translate(url, init);
}

export const googleHtmlReply = (...texts: string[]) => new Response(JSON.stringify([texts]), { headers: { "Content-Type": "application/json" } });
