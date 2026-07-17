/**
 * Chrome native-messaging protocol framer.
 *
 * Wire format: little-endian uint32 length prefix, then JSON-encoded UTF-8
 * payload. Both directions. Max message size Chrome -> host is 4 GB, host ->
 * Chrome is 1 MB. We bound host -> Chrome at 1 MB and split long payloads at
 * the application layer (e.g., screenshots stream in event chunks).
 */

const MAX_HOST_TO_CHROME_BYTES = 1024 * 1024;

export type MessageHandler = (message: unknown) => void;

export class NativeMessagingBridge {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private messageHandlers = new Set<MessageHandler>();
  private closeHandlers = new Set<() => void>();

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.input.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainBuffer();
    });
    this.input.on("end", () => {
      this.handleClose();
    });
    this.input.on("close", () => {
      this.handleClose();
    });
    this.input.on("error", () => {
      this.handleClose();
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  send(message: unknown): void {
    if (this.closed) return;

    const json = JSON.stringify(message);
    const payload = Buffer.from(json, "utf8");

    if (payload.byteLength > MAX_HOST_TO_CHROME_BYTES) {
      throw new Error(
        `Native message exceeds 1 MB cap: ${payload.byteLength} bytes. Chunk at the application layer.`,
      );
    }

    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.byteLength, 0);
    this.output.write(Buffer.concat([header, payload]));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private drainBuffer(): void {
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.byteLength < 4 + length) return;

      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      let message: unknown;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch (err) {
        console.error(
          "[native-host] malformed native message:",
          err,
          payload.toString("utf8").slice(0, 200),
        );
        continue;
      }
      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (err) {
          console.error("[native-host] message handler threw:", err);
        }
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (err) {
        console.error("[native-host] close handler threw:", err);
      }
    }
  }
}
