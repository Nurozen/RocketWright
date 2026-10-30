/**
 * A minimal RFC 6455 WebSocket server endpoint (text frames, ping/pong, close)
 * on a `node:http` upgrade, so the mock RPC server needs no dependency.
 * Enough for one JSON text frame per message; not a general WebSocket library.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 16 * 1024 * 1024;

export interface WsConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
}

export interface WsHandlers {
  message(text: string): void;
  close(): void;
}

/** Completes the handshake, or answers 400 and returns `null`. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, onOpen: (conn: WsConnection) => WsHandlers): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = req.headers.upgrade;
  if (typeof key !== "string" || typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let open = true;
  let buf = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;

  const writeFrame = (opcode: number, payload: Buffer): void => {
    if (socket.destroyed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  const conn: WsConnection = {
    send(text) {
      if (open) writeFrame(0x1, Buffer.from(text, "utf8"));
    },
    close(code = 1000, reason = "") {
      if (!open) return;
      open = false;
      const r = Buffer.from(reason, "utf8");
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      writeFrame(0x8, p);
      socket.end();
      handlers.close();
    },
    get open() {
      return open;
    },
  };
  const handlers = onOpen(conn);

  const fail = (code: number): void => conn.close(code);

  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return fail(1009);
        len = Number(big);
        off = 10;
      }
      // Clients must mask every frame (RFC 6455 §5.1).
      if (!masked) return fail(1002);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      buf = buf.subarray(off + 4 + len);

      if (opcode === 0x8) {
        if (open) {
          open = false;
          writeFrame(0x8, payload.subarray(0, 2));
          socket.end();
          handlers.close();
        }
        return;
      }
      if (opcode === 0x9) {
        writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        fragments = [payload];
        fragmentOpcode = opcode;
      } else if (opcode === 0x0) {
        fragments.push(payload);
      } else {
        return fail(1002);
      }
      if (fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) return fail(1009);
      if (fin) {
        const msg = Buffer.concat(fragments);
        fragments = [];
        // Binary frames are not part of IF10.
        if (fragmentOpcode !== 0x1) return fail(1003);
        handlers.message(msg.toString("utf8"));
      }
    }
  });
  const onEnd = (): void => {
    if (open) {
      open = false;
      handlers.close();
    }
  };
  socket.on("close", onEnd);
  socket.on("error", onEnd);
  return conn;
}
