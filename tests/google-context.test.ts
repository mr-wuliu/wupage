import { afterEach, describe, expect, it, vi } from "vitest";
import { googleHtmlSource, parseGoogleHtml } from "../src/background/google-context";
import { createProvider } from "../src/background/providers";
import { googleHtmlReply, withGoogleAuth } from "./helpers/google-web";

afterEach(() => vi.unstubAllGlobals());

describe("Google HTML paragraph alignment", () => {
  it("escapes source HTML and literal entities before adding indexed context", () => {
    expect(googleHtmlSource(['Use <div> &lt; & "quotes"', "Repeated.", "Repeated."], "Title"))
      .toEqual(['<pre><a i=0>Title</a>\n\n<a i=1>Use &lt;div&gt; &amp;lt; &amp; &quot;quotes&quot;</a>\n\n<a i=2>Repeated.</a>\n\n<a i=3>Repeated.</a></pre>']);
    expect(googleHtmlSource(["One", "Two"])).toEqual(["<pre>One</pre>", "<pre>Two</pre>"]);
  });

  it("bounds reference text and drops excerpts for long batches", () => {
    expect(googleHtmlSource(["Hello"], "x".repeat(2000))[0]).not.toContain("x".repeat(801));
    expect(googleHtmlSource(["x".repeat(300)], "Title\nPrivate excerpt")[0]).not.toContain("Private excerpt");
  });

  it("discards reference/source spans and collects split translations at the same index", () => {
    expect(parseGoogleHtml([["<pre><b><a i=0>标题</a>\n\n<a i=1>第一句。</a></b><i>Title First.</i><b><a i=1>另一句。</a>\n\n<a i=2>重复一。</a>\n\n<a i=3>重复二。</a></b></pre>"]], 3, true))
      .toEqual(["第一句。另一句。", "重复一。", "重复二。"]);
  });

  it("decodes exactly once after stripping transport markup without using DOMParser", () => {
    vi.stubGlobal("DOMParser", undefined);
    expect(parseGoogleHtml([["<pre><b>使用 &lt;div&gt;、&amp;lt;、&#x1f408;。</b><i>Use &lt;div&gt; literally.</i><br>下一行</pre>"]], 1, false))
      .toEqual(["使用 <div>、&lt;、🐈。\n下一行"]);
    expect(parseGoogleHtml([["<pre>&#999999999; &#xD800;</pre>"]], 1, false)).toEqual(["&#999999999; &#xD800;"]);
  });

  it.each([
    "<pre>Title and both paragraphs merged</pre>",
    "<pre><a i=0>标题</a><a i=1>第一句</a></pre>",
    "<pre><a i=0>标题</a><a i=2>第二句</a><a i=1>第一句</a></pre>",
    "<pre><a i=0>标题</a><a i=1>第一句</a>漂移译文<a i=2>第二句</a></pre>",
    "<pre><a i=0>标题</a><a i=1>第一句<a i=2>第二句</a></pre>",
    '<script>alert(1)</script><a i=0>标题</a><a i=1>一</a><a i=2>二</a>',
    "<pre><a i=0>标题</a><a i=99>错误编号</a></pre>"
  ])("rejects missing, reordered or ambiguous paragraphs: %s", html => {
    expect(parseGoogleHtml([[html]], 2, true)).toBeUndefined();
  });

  it.each([null, {}, [], [null], [[null]], [[""]], [["One", "Extra"]]])("rejects malformed payloads: %j", payload => {
    expect(parseGoogleHtml(payload, 1, false)).toBeUndefined();
  });

  it("falls back as a batch if paragraph markers are lost, never displaying reference text", async () => {
    const fetch = vi.fn(async (url: string) => url.includes("/translateHtml")
      ? googleHtmlReply("<pre>参考内容与正文合并了</pre>") : new Response(JSON.stringify(["第一句", "第二句"])));
    vi.stubGlobal("fetch", withGoogleAuth(fetch));
    const provider = createProvider({ type: "google-web-translate", id: "google", label: "Google" });
    await expect(provider.translateBatch({ texts: ["First.", "Second."], context: "Topic", sourceLang: "en", targetLang: "zh-CN" }))
      .resolves.toEqual(["第一句", "第二句"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.getAll("q")).toEqual(["First.", "Second."]);
  });
});
