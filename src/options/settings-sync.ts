import { t } from "../shared/i18n";
import { SETTINGS_BACKUP_MAX_BYTES, SETTINGS_BACKUP_MIME } from "../shared/settings-backup";

const BROWSER_MANIFEST_KEY = "wupage.settings-sync.v1";
const PART_SIZE = 7000;
const PART_KEYS = Array.from({ length: 14 }, (_, index) => `${BROWSER_MANIFEST_KEY}.${index}`);
const WEBDAV_FILENAME = "wupage-preferences.toml";

export async function publishBrowserSettings(text: string): Promise<void> {
  const compressed = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const encoded = encodeBase64(new Uint8Array(compressed));
  if (encoded.length > PART_SIZE * PART_KEYS.length) throw new Error(t("settingsSyncBrowserTooLarge"));

  const snapshot = Object.fromEntries(PART_KEYS.map((key, index) =>
    [key, encoded.slice(index * PART_SIZE, (index + 1) * PART_SIZE) || null]));
  // Sync may replicate individual keys at different times. The reader accepts
  // only parts that match the published digest, including during concurrent writes.
  await chrome.storage.sync.set({
    ...snapshot,
    [BROWSER_MANIFEST_KEY]: { parts: Math.ceil(encoded.length / PART_SIZE), digest: await digest(encoded) }
  }).catch(() => { throw new Error(t("settingsSyncBrowserWriteFailed")); });
}

export async function readBrowserSettings(): Promise<string> {
  const values = await chrome.storage.sync.get([BROWSER_MANIFEST_KEY, ...PART_KEYS])
    .catch(() => { throw new Error(t("settingsSyncBrowserReadFailed")); });
  const manifest = values[BROWSER_MANIFEST_KEY] as { parts: number; digest: string } | undefined;
  if (!manifest) throw new Error(t("settingsSyncBrowserEmpty"));
  if (!Number.isInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > PART_KEYS.length
    || !/^[a-f\d]{64}$/u.test(manifest.digest)) throw browserIncomplete();
  const parts: unknown[] = PART_KEYS.slice(0, manifest.parts).map(key => values[key]);
  if (parts.some((part, index) => typeof part !== "string" || !part.length || part.length > PART_SIZE
    || index < parts.length - 1 && part.length !== PART_SIZE)) throw browserIncomplete();
  const encoded = parts.join("");
  if (await digest(encoded) !== manifest.digest) throw browserIncomplete();
  try {
    const compressed = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    return await readBackupText(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")));
  } catch {
    throw browserIncomplete();
  }
}

function browserIncomplete(): Error { return new Error(t("settingsSyncBrowserIncomplete")); }

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

export function webDavSettings(folder: string, username: string, password: string) {
  let file: URL;
  try {
    file = new URL(folder.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(file.hostname);
    if (!(file.protocol === "https:" || (file.protocol === "http:" && loopback))
      || file.username || file.password || /[?#]/u.test(file.href)) throw new Error();
  } catch {
    throw new Error(t("settingsSyncDavInvalidUrl"));
  }
  if (username.includes(":") || !username && password) throw new Error(t("settingsSyncDavInvalidLogin"));
  file.pathname = `${file.pathname.replace(/\/$/u, "")}/${WEBDAV_FILENAME}`;
  const authorization = username ? `Basic ${encodeBase64(new TextEncoder().encode(`${username}:${password}`))}` : "";

  function request(method: "HEAD" | "GET" | "PUT", headers?: Record<string, string>, body?: string): Promise<Response> {
    return fetch(file, {
      method, body, cache: "no-store", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { ...(authorization ? { Authorization: authorization } : {}), ...headers }
    }).catch(() => { throw new Error(t("settingsSyncDavConnectionFailed")); });
  }

  return {
    destination: file.href,
    async revision(): Promise<string | null> {
      let response = await request("HEAD");
      if (response.status === 405 || response.status === 501) {
        response = await request("GET");
        await discard(response);
      }
      if (response.status === 404) return null;
      if (response.status !== 200) throw webDavError(response.status);
      const etag = response.headers.get("ETag");
      if (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/u.test(etag)) throw new Error(t("settingsSyncDavMissingEtag"));
      return etag;
    },
    async write(text: string, revision: string | null): Promise<void> {
      const response = await request("PUT", {
        "Content-Type": `${SETTINGS_BACKUP_MIME}; charset=utf-8`,
        [revision === null ? "If-None-Match" : "If-Match"]: revision ?? "*"
      }, text);
      await discard(response);
      if (!response.ok) throw webDavError(response.status);
    },
    async read(): Promise<string> {
      const response = await request("GET");
      if (response.status !== 200 || !response.body) {
        await discard(response);
        throw webDavError(response.status);
      }
      if (Number(response.headers.get("Content-Length")) > SETTINGS_BACKUP_MAX_BYTES) {
        await discard(response);
        throw tooLarge();
      }
      return readBackupText(response.body);
    }
  };
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function webDavError(status: number): Error {
  if (status === 401 || status === 403) return new Error(t("settingsSyncDavUnauthorized"));
  if (status === 404) return new Error(t("settingsSyncDavEmpty"));
  if (status === 409) return new Error(t("settingsSyncDavFolderMissing"));
  if (status === 412) return new Error(t("settingsSyncDavConflict"));
  return new Error(t("settingsSyncDavHttpError", status));
}

function tooLarge(): Error { return new Error(t("settingsBackupsMustBe5MibOrSmaller")); }

async function readBackupText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  const chunks: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => { throw new Error(t("settingsSyncDavConnectionFailed")); });
      if (done) break;
      size += value.byteLength;
      if (size > SETTINGS_BACKUP_MAX_BYTES) throw tooLarge();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks.join("") + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof TypeError) throw new Error(t("settingsSyncInvalidBackup"));
    throw error;
  } finally {
    reader.releaseLock();
  }
}
