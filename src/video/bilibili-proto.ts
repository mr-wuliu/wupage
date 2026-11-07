import { t } from "../shared/i18n";
/** Minimal decoder for the subtitle track fields returned by Bilibili's web/view endpoint. */
interface Field { id: number; bytes?: Uint8Array }
function fields(buffer: Uint8Array): Field[] {
  let offset = 0;
  const result: Field[] = [];
  const integer = () => {
    let value = 0; let scale = 1;
    for (let count = 0; count < 10 && offset < buffer.length; count++) {
      const byte = buffer[offset++]; value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw new Error(t("invalidSubtitleTrackData"));
  };
  while (offset < buffer.length) {
    if (result.length > 5000) throw new Error(t("subtitleTrackDataTooLarge"));
    const tag = integer(); const id = Math.floor(tag / 8); const wire = tag & 7;
    if (!id) throw new Error(t("invalidSubtitleTrackData"));
    if (wire === 0) { integer(); result.push({ id }); }
    else if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; result.push({ id }); }
    else if (wire === 2) {
      const length = integer();
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) throw new Error(t("invalidSubtitleTrackData"));
      result.push({ id, bytes: buffer.subarray(offset, offset + length) }); offset += length;
    } else throw new Error(t("unsupportedSubtitleTrackFormat"));
    if (offset > buffer.length) throw new Error(t("invalidSubtitleTrackData"));
  }
  return result;
}

export function bilibiliProtoTracks(buffer: Uint8Array): Array<{ id_str: string; lan: string; lan_doc: string; subtitle_url: string }> {
  if (buffer.byteLength > 4 * 1024 * 1024) throw new Error(t("subtitleTrackDataTooLarge"));
  const data = fields(buffer).find(field => field.id === 1)?.bytes;
  if (!data) return [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const tracks = [];
  for (const item of fields(data).filter(field => field.id === 3 && field.bytes).slice(0, 200)) {
    const values = fields(item.bytes!);
    const text = (id: number) => { const value = values.find(field => field.id === id)?.bytes; return value ? decoder.decode(value) : ""; };
    const language = text(3); const url = text(5); const id = text(2); const label = text(4);
    if (/^[\w-]{2,32}$/u.test(language) && id.length <= 128 && label.length <= 200 && /^(?:https:)?\/\//u.test(url)) {
      tracks.push({ id_str: id || language, lan: language, lan_doc: label || language, subtitle_url: url });
    }
  }
  return tracks;
}
