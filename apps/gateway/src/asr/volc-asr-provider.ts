import WebSocket from "ws";
import {
  decodeServerFrame,
  encodeAudioRequest,
  encodeFullClientRequest,
  type VolcAsrProviderEvents,
  type VolcAsrRequestConfig,
  TypedEventEmitter,
} from "./volc-asr-protocol.js";

export type VolcAsrProviderOptions = {
  apiKey: string;
  resourceId: string;
  url: string;
  requestId: string;
  uid: string;
  requestConfig?: Omit<VolcAsrRequestConfig, "uid">;
};

export class VolcAsrProvider extends TypedEventEmitter<VolcAsrProviderEvents> {
  private socket: WebSocket | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: VolcAsrProviderOptions) {
    super();
  }

  async start() {
    if (this.started) return;
    this.started = true;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers: {
          "X-Api-Key": this.options.apiKey,
          "X-Api-Resource-Id": this.options.resourceId,
          "X-Api-Request-Id": this.options.requestId,
          "X-Api-Sequence": "-1",
        },
      });
      this.socket = socket;

      const failStartup = (error: Error) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(error);
          return;
        }
        this.emit("error", error);
      };

      socket.once("open", () => {
        const config: VolcAsrRequestConfig = {
          uid: this.options.uid,
          ...this.options.requestConfig,
        };
        socket.send(encodeFullClientRequest(config));
        resolve();
      });
      socket.on("message", (data) => {
        try {
          const buffer = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data.map((item) => Buffer.from(item)))
              : Buffer.from(data as ArrayBuffer);
          const result = decodeServerFrame(buffer);
          if (result) this.emit("result", result);
        } catch (error) {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("error", failStartup);
      socket.once("close", () => {
        this.closed = true;
        this.emit("close");
      });
    });
  }

  sendAudio(audio: Buffer) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.closed) return;
    this.socket.send(encodeAudioRequest(audio));
  }

  stop(lastAudio?: Buffer) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.closed) return;
    this.socket.send(encodeAudioRequest(lastAudio ?? Buffer.alloc(0), { last: true }));
  }

  close() {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}
