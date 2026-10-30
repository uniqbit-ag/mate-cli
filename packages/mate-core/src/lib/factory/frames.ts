/**
 * The attach protocol's framing: one type byte, a 4-byte big-endian length, the
 * payload. Data frames carry terminal bytes; control frames carry one JSON object.
 */

export const FRAME_DATA = 0;
export const FRAME_CONTROL = 1;
/** Standard error of a non-TTY attach; a TTY attach sends everything as data. */
export const FRAME_STDERR = 2;
/** Larger than any terminal write or control message; a bigger frame means a broken peer. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export type Frame =
  | { type: typeof FRAME_DATA | typeof FRAME_STDERR; data: Uint8Array }
  | { type: typeof FRAME_CONTROL; message: Record<string, unknown> };

export function encodeData(data: Uint8Array | string): Uint8Array {
  return encode(FRAME_DATA, typeof data === "string" ? new TextEncoder().encode(data) : data);
}

export function encodeStderr(data: Uint8Array): Uint8Array {
  return encode(FRAME_STDERR, data);
}

export function encodeControl(message: Record<string, unknown>): Uint8Array {
  return encode(FRAME_CONTROL, new TextEncoder().encode(JSON.stringify(message)));
}

function encode(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, payload.byteLength);
  frame.set(payload, 5);
  return frame;
}

export class FrameError extends Error {}

/** Reassembles frames from arbitrary chunks. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.byteLength);
    this.buffer = joined;
    const frames: Frame[] = [];
    while (this.buffer.byteLength >= 5) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
      const type = this.buffer[0]!;
      const length = view.getUint32(1);
      if (length > MAX_FRAME_BYTES) throw new FrameError("frame too large");
      if (type !== FRAME_DATA && type !== FRAME_CONTROL && type !== FRAME_STDERR) {
        throw new FrameError("unknown frame type");
      }
      if (this.buffer.byteLength < 5 + length) break;
      const payload = this.buffer.slice(5, 5 + length);
      this.buffer = this.buffer.slice(5 + length);
      if (type === FRAME_DATA || type === FRAME_STDERR) {
        frames.push({ type, data: payload });
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        throw new FrameError("malformed control frame");
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new FrameError("a control frame must be a JSON object");
      }
      frames.push({ type: FRAME_CONTROL, message: message as Record<string, unknown> });
    }
    return frames;
  }
}
