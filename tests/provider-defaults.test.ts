import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { restoreProviderParameters } from "../src/options/provider-defaults";
import type { ProviderConfig } from "../src/shared/types";

it("retains API credentials while restoring built-in service parameters", () => {
  const provider = { type: "volcengine-web-translate", id: "volcengine-web-translate", label: "Edited", serviceMode: "api",
    performanceMode: "custom", chunkSize: 900, concurrency: 2,
    api: { accessKeyId: "private-id", secretAccessKey: "private-secret", region: "other-region" } } satisfies ProviderConfig;
  expect(restoreProviderParameters(provider)).toMatchObject({ label: "火山翻译", chunkSize: 900, concurrency: 2,
    api: { accessKeyId: "private-id", secretAccessKey: "private-secret", region: "cn-north-1" } });
});

it("keeps template credentials and custom models without leaving custom requests enabled", () => {
  const provider = { ...structuredClone(DEFAULT_SETTINGS.providers.find(provider => provider.type === "deepseek")!),
    apiKey: "private-key", customModels: ["private-model"],
    requestTemplate: { enabled: true, headers: '{"Authorization":"private-token"}', body: '{"token":"private-body"}' } };
  const restored = restoreProviderParameters(provider);
  expect(restored).toMatchObject({ apiKey: "private-key", customModels: ["private-model"],
    requestTemplate: { enabled: false, headers: '{"Authorization":"private-token"}', body: '{"token":"private-body"}' } });
  expect(provider.requestTemplate.enabled).toBe(true);
  expect(DEFAULT_SETTINGS.providers.find(provider => provider.type === "deepseek")!.apiKey).toBe("");
});

it.each(["http-template", "custom-http"])("preserves every field of a %s request because any field can contain a credential", id => {
  const provider = { type: "http-template", id, label: "Private request", method: "POST", url: "https://example.com?token=secret",
    headers: { Authorization: "secret" }, bodyTemplate: "private body", responsePath: "private.path" } satisfies ProviderConfig;
  expect(restoreProviderParameters(provider)).toEqual(provider);
});

it("retains all fields of a custom LLM service", () => {
  const provider = { ...structuredClone(DEFAULT_SETTINGS.providers.find(provider => provider.type === "deepseek")!),
    id: "custom-llm", label: "Private model service", apiKey: "private-key", baseURL: "https://private.example/v1" };
  expect(restoreProviderParameters(provider)).toEqual(provider);
});
