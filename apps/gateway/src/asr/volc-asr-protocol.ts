import { EventEmitter } from "node:events";
import { gunzipSync, gzipSync } from "node:zlib";

export type VolcAsrRequestConfig = {
  uid: string;
  language?: string | null;
  endWindowSizeMs?: number | null;
  forceToSpeechTimeMs?: number | null;
  enableNonstream?: boolean;
  ssdVersion?: string | null;
  enablePunctuation?: boolean;
  enableItn?: boolean;
  enableDdc?: boolean;
  corpus?: VolcAsrCorpusConfig | null;
};

export type VolcAsrCorpusConfig = {
  boostingTableName?: string | null;
  boostingTableId?: string | null;
  correctTableName?: string | null;
  correctTableId?: string | null;
  context?: string | null;
};

export type VolcAsrResult = {
  text: string;
  definite: boolean;
  raw: unknown;
};

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE_WORDS = 0b0001;

const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0b0010;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_TYPE_ERROR_RESPONSE = 0b1111;

const FLAG_NONE = 0b0000;
const FLAG_LAST_PACKET = 0b0010;
const FLAG_WITH_SEQUENCE = 0b0001;
const FLAG_LAST_WITH_SEQUENCE = 0b0011;

const SERIALIZATION_NONE = 0b0000;
const SERIALIZATION_JSON = 0b0001;
const COMPRESSION_GZIP = 0b0001;

const makeHeader = (input: {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
}) => Buffer.from([
  (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
  (input.messageType << 4) | input.flags,
  (input.serialization << 4) | input.compression,
  0,
]);

const withPayloadSize = (header: Buffer, payload: Buffer) => {
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
};

const buildRequestPayload = (config: VolcAsrRequestConfig) => {
  const audio: Record<string, unknown> = {
    format: "pcm",
    codec: "raw",
    rate: 16000,
    bits: 16,
    channel: 1,
  };
  if (config.language) audio.language = config.language;

  const corpus: Record<string, unknown> = {};
  if (config.corpus?.boostingTableName) corpus.boosting_table_name = config.corpus.boostingTableName;
  if (config.corpus?.boostingTableId) corpus.boosting_table_id = config.corpus.boostingTableId;
  if (config.corpus?.correctTableName) corpus.correct_table_name = config.corpus.correctTableName;
  if (config.corpus?.correctTableId) corpus.correct_table_id = config.corpus.correctTableId;
  if (config.corpus?.context) corpus.context = config.corpus.context;

  const request: Record<string, unknown> = {
    model_name: "bigmodel",
    enable_itn: config.enableItn ?? true,
    enable_punc: config.enablePunctuation ?? true,
    enable_ddc: config.enableDdc ?? false,
    enable_nonstream: config.enableNonstream ?? true,
    show_utterances: true,
    result_type: "single",
  };
  if (request.enable_nonstream === true) request.ssd_version = config.ssdVersion ?? "200";
  if (config.endWindowSizeMs != null) request.end_window_size = config.endWindowSizeMs;
  if (config.forceToSpeechTimeMs != null) request.force_to_speech_time = config.forceToSpeechTimeMs;
  if (Object.keys(corpus).length > 0) request.corpus = corpus;

  return {
    user: { uid: config.uid },
    audio,
    request,
  };
};

export const encodeFullClientRequest = (config: VolcAsrRequestConfig) => {
  const payload = gzipSync(Buffer.from(JSON.stringify(buildRequestPayload(config)), "utf-8"));
  return withPayloadSize(
    makeHeader({
      messageType: MESSAGE_TYPE_FULL_CLIENT_REQUEST,
      flags: FLAG_NONE,
      serialization: SERIALIZATION_JSON,
      compression: COMPRESSION_GZIP,
    }),
    payload,
  );
};

export const encodeAudioRequest = (audio: Buffer, options?: { last?: boolean }) => {
  const payload = gzipSync(audio);
  return withPayloadSize(
    makeHeader({
      messageType: MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
      flags: options?.last ? FLAG_LAST_PACKET : FLAG_NONE,
      serialization: SERIALIZATION_NONE,
      compression: COMPRESSION_GZIP,
    }),
    payload,
  );
};

const readPayload = (buffer: Buffer, offset: number, compressed: boolean) => {
  if (buffer.length < offset + 4) throw new Error("invalid volc asr frame: missing payload size");
  const payloadSize = buffer.readUInt32BE(offset);
  const payloadStart = offset + 4;
  const payloadEnd = payloadStart + payloadSize;
  if (buffer.length < payloadEnd) throw new Error("invalid volc asr frame: truncated payload");
  const payload = buffer.subarray(payloadStart, payloadEnd);
  return compressed ? gunzipSync(payload) : payload;
};

const extractTextResult = (raw: unknown): VolcAsrResult | null => {
  if (!raw || typeof raw !== "object") return null;
  const result = (raw as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;

  const utterances = (result as { utterances?: unknown }).utterances;
  if (Array.isArray(utterances) && utterances.length > 0) {
    const last = utterances[utterances.length - 1];
    if (last && typeof last === "object") {
      const text = (last as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        return { text, definite: (last as { definite?: unknown }).definite === true, raw };
      }
    }
  }

  const text = (result as { text?: unknown }).text;
  if (typeof text === "string" && text.length > 0) {
    return { text, definite: false, raw };
  }
  return null;
};

export const decodeServerFrame = (data: Buffer): VolcAsrResult | null => {
  if (data.length < 4) throw new Error("invalid volc asr frame: missing header");

  const headerSize = (data.readUInt8(0) & 0x0f) * 4;
  const secondByte = data.readUInt8(1);
  const thirdByte = data.readUInt8(2);
  const messageType = secondByte >> 4;
  const flags = secondByte & 0x0f;
  const serialization = thirdByte >> 4;
  const compression = thirdByte & 0x0f;
  const compressed = compression === COMPRESSION_GZIP;

  if (messageType === MESSAGE_TYPE_ERROR_RESPONSE) {
    if (data.length < headerSize + 8) throw new Error("invalid volc asr error frame");
    const code = data.readUInt32BE(headerSize);
    const messageSize = data.readUInt32BE(headerSize + 4);
    const messageStart = headerSize + 8;
    const message = data.subarray(messageStart, messageStart + messageSize).toString("utf-8");
    throw new Error(`volc asr error ${code}: ${message}`);
  }

  if (messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE) return null;

  let offset = headerSize;
  if (flags === FLAG_WITH_SEQUENCE || flags === FLAG_LAST_WITH_SEQUENCE) offset += 4;
  const payload = readPayload(data, offset, compressed);
  if (serialization !== SERIALIZATION_JSON) return null;

  const raw = JSON.parse(payload.toString("utf-8")) as unknown;
  return extractTextResult(raw);
};

export class VolcAsrProtocolError extends Error {}

export type VolcAsrProviderEvents = {
  result: [VolcAsrResult];
  error: [Error];
  close: [];
};

export class TypedEventEmitter<TEvents extends Record<string, unknown[]>> extends EventEmitter {
  override on<TEvent extends keyof TEvents & string>(event: TEvent, listener: (...args: TEvents[TEvent]) => void): this {
    return super.on(event, listener);
  }

  override emit<TEvent extends keyof TEvents & string>(event: TEvent, ...args: TEvents[TEvent]): boolean {
    return super.emit(event, ...args);
  }
}
