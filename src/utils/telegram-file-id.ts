import { createHmac, timingSafeEqual } from "crypto";
import { PlaybackPeer } from "../modules/telegram/types";

export interface TelegramFileReference {
  v: 1;
  peer: PlaybackPeer;
  messageId: number;
}

export function encodeTelegramFileId(token: string, peer: PlaybackPeer, messageId: number): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, peer, messageId })).toString("base64url");
  const signature = createHmac("sha256", token).update(payload).digest("base64url");
  return `tg_file_${payload}.${signature}`;
}

export function decodeTelegramFileId(token: string, id: string): TelegramFileReference | null {
  if (id.length > 1024) return null;
  const match = /^tg_file_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(id);
  if (!match) return null;
  const expected = createHmac("sha256", token).update(match[1]).digest();
  const actual = Buffer.from(match[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64url").toString()) as TelegramFileReference;
    const peer = value?.peer;
    if (value.v !== 1 || !Number.isInteger(value.messageId) || value.messageId < 1 || value.messageId > 2147483647) return null;
    if (!peer || !["channel", "chat", "user", "self"].includes(peer.kind) ||
      typeof peer.id !== "string" || !/^[1-9]\d{0,18}$/.test(peer.id) || BigInt(peer.id) > 9223372036854775807n) return null;
    if (peer.kind === "channel" || peer.kind === "user") {
      if (typeof peer.accessHash !== "string" || !/^-?[1-9]\d{0,18}$/.test(peer.accessHash)) return null;
      const hash = BigInt(peer.accessHash);
      if (hash < -9223372036854775808n || hash > 9223372036854775807n) return null;
    }
    return value;
  } catch {
    return null;
  }
}
