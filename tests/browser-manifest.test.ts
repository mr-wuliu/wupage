import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json";
import { browserManifest } from "../build/manifest";
import signing from "../build/chromium-signing.json";
import { createHash } from "node:crypto";

describe("browser package boundaries", () => {
  it("preserves the Chromium manifest and leaves the shared source untouched", () => {
    const snapshot = structuredClone(manifest);
    expect(browserManifest(manifest, false)).toEqual({ ...snapshot, key: signing.publicKey });
    expect(browserManifest(manifest, false)).not.toHaveProperty("update_url");
    const firefox = browserManifest(manifest, true);
    expect(manifest).toEqual(snapshot);
    expect(firefox.background).toEqual({ scripts: ["background.js"], type: "module" });
    expect(firefox.permissions).not.toContain("offscreen");
    expect(firefox.permissions).toContain("declarativeNetRequestWithHostAccess");
    expect(firefox.content_security_policy.sandbox).toContain("moz-extension:");
    expect(firefox.content_security_policy.sandbox).not.toContain("chrome-extension:");
    expect(firefox.browser_specific_settings?.gecko).toMatchObject({
      strict_min_version: "154.0", data_collection_permissions: { required: ["websiteContent", "authenticationInfo"] }
    });
    expect(firefox.version).toBe(manifest.version);
    expect(firefox).not.toHaveProperty("key");
    expect(firefox).not.toHaveProperty("update_url");
  });

  it("pins the extension ID to the public key used for signed Chromium builds", () => {
    const hex = createHash("sha256").update(Buffer.from(signing.publicKey, "base64")).digest("hex").slice(0, 32);
    expect([...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join("")).toBe(signing.extensionId);
    const source = { ...manifest, key: "old-key", update_url: signing.updateUrl };
    expect(browserManifest(source, false).key).toBe(signing.publicKey);
    expect(browserManifest(source, true)).not.toHaveProperty("update_url");
    expect(source.update_url).toBe(signing.updateUrl);
  });
});
