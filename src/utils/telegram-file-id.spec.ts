import { createHmac } from "crypto";
import { decodeTelegramFileId, encodeTelegramFileId } from "./telegram-file-id";
import { PlaybackPeer } from "../modules/telegram/types";

describe("Telegram file IDs", () => {
  const peers: PlaybackPeer[] = [
    { kind: "channel", id: "9223372036854775807", accessHash: "-9223372036854775808" },
    { kind: "user", id: "2", accessHash: "345" },
    { kind: "chat", id: "3" }, { kind: "self", id: "4" },
  ];
  it.each(peers)("round-trips a durable $kind reference", peer => {
    const id = encodeTelegramFileId("account-secret", peer, 123);
    expect(decodeTelegramFileId("account-secret", id)).toEqual({ v: 1, peer, messageId: 123 });
    expect(id).not.toContain("account-secret");
    expect(decodeTelegramFileId("another-account", id)).toBeNull();
    expect(decodeTelegramFileId("account-secret", id.replace("tg_file_", "tg_file_x"))).toBeNull();
  });
  it.each([
    { v: 2, peer: peers[0], messageId: 1 },
    { v: 1, peer: peers[0], messageId: -1 },
    { v: 1, peer: peers[0], messageId: 2147483648 },
    { v: 1, peer: { kind: "channel", id: "1" }, messageId: 1 },
    { v: 1, peer: { kind: "chat", id: "9223372036854775808" }, messageId: 1 },
  ])("rejects invalid signed fields %#", value => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = createHmac("sha256", "token").update(payload).digest("base64url");
    expect(decodeTelegramFileId("token", `tg_file_${payload}.${signature}`)).toBeNull();
  });
  it.each(["tg_file_invalid", "tg_file_" + "a".repeat(1100), "tt123"])("rejects malformed ID", id => {
    expect(decodeTelegramFileId("token", id)).toBeNull();
  });
});
