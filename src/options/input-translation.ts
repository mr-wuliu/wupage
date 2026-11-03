import { DEFAULT_INPUT_PROMPT, isInputTranslationProvider, normalizeInputTranslation, pickInputProvider,
  type InputTranslationSettings } from "../shared/input-translation";
import type { ExtensionSettings, ProviderConfig } from "../shared/types";

function optionLabel(provider: ProviderConfig): string {
  if (provider.enabled === false) return `${provider.label}（已停用）`;
  return isInputTranslationProvider(provider) ? provider.label : `${provider.label}（未配置）`;
}

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
      ? "输入框翻译需要可用的翻译服务，请先在「翻译服务」中启用并配置一个服务。"
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
      for (const item of value.providers) options.push(new Option(optionLabel(item), item.id));
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
