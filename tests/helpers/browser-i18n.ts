import chinese from "../../public/_locales/zh_CN/messages.json";

// Most UI regression tests exercise the original Chinese interface. Keep their
// locale deterministic, including tests that replace chrome with partial mocks.
export function catalogApi(messages: Record<string, { message: string }>) {
  return {
    getMessage(key: string, values: string[] = []) {
      return messages[key]?.message.replace(/\$ARG(\d+)\$/g, (_, index) => values[Number(index) - 1] ?? "") ?? "";
    }
  };
}

Object.defineProperty(globalThis, "browser", { configurable: true, value: { i18n: catalogApi(chinese) } });
