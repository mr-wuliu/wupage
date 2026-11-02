import { DEFAULT_INPUT_PROMPT, isInputTranslationProvider, normalizeInputTranslation, pickInputProvider,
  type InputTranslationSettings } from "../shared/input-translation";
import { isLlmProvider } from "../shared/performance";
import type { ExtensionSettings } from "../shared/types";

export function setupInputTranslationControls(root: HTMLElement): {
  render: (settings: ExtensionSettings) => void;
  read: () => InputTranslationSettings;
} {
  const query = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
  const enabled = query<HTMLInputElement>("#inputTranslationEnabled");
  const fields = query<HTMLFieldSetElement>("#inputTranslationFields");
  const provider = query<HTMLSelectElement>("#inputTranslationProvider");
  const status = query<HTMLElement>("#inputTranslationProviderStatus");
  const prompt = query<HTMLTextAreaElement>("#inputTranslationPrompt");
  let settings: ExtensionSettings | undefined;

  function updateStatus(): void {
    if (!settings) return;
    const chosen = pickInputProvider({ ...settings, inputTranslation: { ...normalizeInputTranslation(settings.inputTranslation), providerId: provider.value } });
    status.textContent = !chosen
      ? "输入框翻译需要大模型服务，请先在「翻译服务」中配置 OpenAI 兼容或 Anthropic 兼容服务的地址、模型和 API Key。"
      : provider.value && chosen.id !== provider.value ? `所选服务不可用，将使用「${chosen.label}」。` : `将使用「${chosen.label}」。`;
    status.dataset.state = chosen ? "ready" : "missing";
  }

  enabled.addEventListener("change", () => { fields.disabled = !enabled.checked; });
  provider.addEventListener("change", updateStatus);
  query<HTMLButtonElement>("#resetInputTranslationPrompt").addEventListener("click", () => { prompt.value = DEFAULT_INPUT_PROMPT; });

  return {
    render(value) {
      settings = value;
      const current = normalizeInputTranslation(value.inputTranslation);
      const options = [new Option("自动选择", "")];
      for (const item of value.providers.filter(isLlmProvider)) {
        options.push(new Option(isInputTranslationProvider(item) ? item.label : `${item.label}（未配置）`, item.id));
      }
      if (current.providerId && !options.some(option => option.value === current.providerId)) {
        options.push(new Option("已移除的服务", current.providerId));
      }
      provider.replaceChildren(...options);
      provider.value = current.providerId;
      enabled.checked = current.enabled;
      fields.disabled = !current.enabled;
      prompt.value = current.prompt;
      updateStatus();
    },
    read: () => normalizeInputTranslation({ enabled: enabled.checked, providerId: provider.value, prompt: prompt.value })
  };
}
