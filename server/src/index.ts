import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import type { AdminSnapshot, ChatMessage, ChatMessageDraft, ClientEvent, ServerEvent, User } from "./types";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_NICKNAME_LENGTH = 24;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_MESSAGE_UTF8_BYTES = 12_000;
const MAX_PRIVATE_CIPHERTEXT_LENGTH = Math.ceil((MAX_MESSAGE_UTF8_BYTES + 16) / 3) * 4;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const allowedOrigins = process.env.CLIENT_ORIGIN
  ?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

interface ClientState {
  user: User | null;
  isAlive: boolean;
  joinedAt: number;
  adminSubscribed: boolean;
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : true }));
app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "echo-chat", connected: clients.size });
});

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
  verifyClient: (info, done) => {
    if (!allowedOrigins?.length || !info.origin) {
      done(true);
      return;
    }
    done(allowedOrigins.includes(info.origin), 403, "Origin not allowed");
  },
});
const clients = new Map<WebSocket, ClientState>();
const bannedNicknames = new Set<string>();

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function sameSecret(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function publicUsers(roomId: string | null): User[] {
  return [...clients.values()]
    .map((state) => state.user)
    .filter((user): user is User => user !== null && user.roomId === roomId);
}

function createAdminSnapshot(): AdminSnapshot {
  const users = [...clients.values()]
    .map((state) => state.user)
    .filter((user): user is User => user !== null);
  const roomCounts = new Map<string | null, number>();
  for (const user of users) roomCounts.set(user.roomId, (roomCounts.get(user.roomId) ?? 0) + 1);
  const rooms = [...roomCounts.entries()]
    .map(([roomId, userCount]) => ({ roomId, userCount }))
    .sort((left, right) => (left.roomId ?? "").localeCompare(right.roomId ?? ""));
  return { rooms, users };
}

function sendAdminSnapshot(socket: WebSocket): void {
  const state = clients.get(socket);
  if (!state?.user?.isAdmin || !state.adminSubscribed) return;
  send(socket, { type: "ADMIN_SNAPSHOT", snapshot: createAdminSnapshot() });
}

function updateAdminSubscribers(except?: WebSocket): void {
  for (const [socket, state] of clients) {
    if (socket !== except && state.user?.isAdmin && state.adminSubscribed) sendAdminSnapshot(socket);
  }
}

function broadcastRoom(roomId: string | null, event: ServerEvent, except?: WebSocket): void {
  for (const [socket, state] of clients) {
    if (socket !== except && state.user?.roomId === roomId) send(socket, event);
  }
}

function sendError(socket: WebSocket, message: string): void {
  send(socket, { type: "ERROR", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(raw: Buffer): ClientEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  if (parsed.type === "JOIN") {
    if (typeof parsed.nickname !== "string") return null;
    if (parsed.roomId !== undefined && typeof parsed.roomId !== "string") return null;
    if (parsed.adminToken !== undefined && typeof parsed.adminToken !== "string") return null;
    return {
      type: "JOIN",
      nickname: parsed.nickname,
      ...(typeof parsed.roomId === "string" ? { roomId: parsed.roomId } : {}),
      ...(typeof parsed.adminToken === "string" ? { adminToken: parsed.adminToken } : {}),
    };
  }
  if (parsed.type === "MESSAGE" && isRecord(parsed.message)) {
    return { type: "MESSAGE", message: parsed.message as unknown as ChatMessageDraft };
  }
  if (parsed.type === "PING" && typeof parsed.sentAt === "number" && Number.isFinite(parsed.sentAt)) {
    return { type: "PING", sentAt: parsed.sentAt };
  }
  if (parsed.type === "BAN_USER" && typeof parsed.targetId === "string") {
    return { type: "BAN_USER", targetId: parsed.targetId };
  }
  if (parsed.type === "ADMIN_SUBSCRIBE" || parsed.type === "ADMIN_REFRESH") {
    return { type: parsed.type };
  }
  return null;
}

function validateMessage(value: ChatMessageDraft, state: ClientState): string | null {
  if (!isRecord(value)) return "Malformed message.";
  if (typeof value.id !== "string" || value.id.length > 64 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)) {
    return "Message id must be a UUID v4.";
  }
  if (value.author !== state.user?.nickname) return "Message author does not match your session.";
  if (typeof value.sentAt !== "string" || !Number.isFinite(Date.parse(value.sentAt)) || new Date(value.sentAt).toISOString() !== value.sentAt) {
    return "Message timestamp must be a valid ISO 8601 timestamp.";
  }
  if (typeof value.text !== "string" || value.text.length === 0) return "Message text cannot be empty.";
  if (typeof value.isPrivate !== "boolean") return "Message privacy flag is required.";
  if (value.isPrivate ? value.text.length > MAX_PRIVATE_CIPHERTEXT_LENGTH : Buffer.byteLength(value.text, "utf8") > MAX_MESSAGE_UTF8_BYTES) {
    return "Message text exceeds the allowed size.";
  }
  if (state.user?.roomId) {
    if (!value.isPrivate || value.roomId !== state.user.roomId) return "Private room messages must include the current room id.";
    if (typeof value.iv !== "string" || !isCanonicalBase64(value.iv) || Buffer.from(value.iv, "base64").length !== 12) return "Private messages require a valid 96-bit Base64 IV.";
    if (!isCanonicalBase64(value.text) || Buffer.from(value.text, "base64").length < 16) return "Private message payload must be Base64 AES-GCM ciphertext.";
  } else if (value.isPrivate || value.roomId !== undefined || value.iv !== undefined) {
    return "Hub messages must be public.";
  }
  return null;
}

function handleJoin(socket: WebSocket, state: ClientState, event: Extract<ClientEvent, { type: "JOIN" }>): void {
  if (state.user) {
    sendError(socket, "This connection has already joined.");
    return;
  }
  const nickname = event.nickname.trim();
  if (!/^[\p{L}\p{N}_ -]{1,24}$/u.test(nickname) || nickname.length > MAX_NICKNAME_LENGTH) {
    sendError(socket, "Nickname must be 1–24 letters, numbers, spaces, underscores, or hyphens.");
    return;
  }
  const normalized = nickname.toLocaleLowerCase();
  if (bannedNicknames.has(normalized)) {
    socket.close(1008, "You are banned from this chat.");
    return;
  }
  const roomId = event.roomId?.trim() || null;
  if (roomId && (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId) || roomId.length > MAX_ROOM_ID_LENGTH)) {
    sendError(socket, "Room id may contain only letters, numbers, underscores, and hyphens (up to 64 characters).");
    return;
  }
  if ([...clients.values()].some((client) => client.user?.roomId === roomId && client.user.nickname.toLocaleLowerCase() === normalized)) {
    sendError(socket, "That nickname is already in use in this channel.");
    return;
  }
  const isAdmin = sameSecret(event.adminToken ?? "", ADMIN_TOKEN);
  const user: User = { id: uuidv4(), nickname, roomId, isAdmin };
  state.user = user;
  state.adminSubscribed = isAdmin;
  send(socket, { type: "WELCOME", user, users: publicUsers(roomId) });
  broadcastRoom(roomId, { type: "USER_JOINED", user }, socket);
  broadcastRoom(roomId, { type: "USERS", users: publicUsers(roomId) });
  if (isAdmin) sendAdminSnapshot(socket);
  updateAdminSubscribers(socket);
}

function handleMessage(socket: WebSocket, state: ClientState, message: ChatMessageDraft): void {
  if (!state.user) {
    sendError(socket, "Join the chat before sending messages.");
    return;
  }
  const error = validateMessage(message, state);
  if (error) {
    sendError(socket, error);
    return;
  }
  const receivedAt = new Date().toISOString();
  const acceptedMessage: ChatMessage = {
    id: message.id,
    author: state.user.nickname,
    sentAt: message.sentAt,
    receivedAt,
    text: message.text,
    isPrivate: message.isPrivate,
    ...(state.user.roomId ? { roomId: state.user.roomId, iv: message.iv } : {}),
  };
  broadcastRoom(state.user.roomId, { type: "MESSAGE", message: acceptedMessage });
}

function handleBan(socket: WebSocket, state: ClientState, targetId: string): void {
  if (!state.user?.isAdmin) {
    sendError(socket, "Administrator authorization is required to ban users.");
    return;
  }
  const target = [...clients.entries()].find(([, targetState]) => targetState.user?.id === targetId);
  const bannedUser = target?.[1].user;
  if (!target || target[0] === socket || !bannedUser) {
    sendError(socket, "Target user is not available for banning.");
    return;
  }
  const [targetSocket] = target;
  bannedNicknames.add(bannedUser.nickname.toLocaleLowerCase());
  targetSocket.close(1008, "You have been banned by a chat administrator.");
}

wss.on("connection", (socket) => {
  const state: ClientState = { user: null, isAlive: true, joinedAt: Date.now(), adminSubscribed: false };
  clients.set(socket, state);
  socket.on("pong", () => {
    state.isAlive = true;
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary || !Buffer.isBuffer(data) || data.byteLength > MAX_PAYLOAD_BYTES) {
      socket.close(1009, "Message payload is too large or binary frames are not supported.");
      return;
    }
    const event = parseEvent(data);
    if (!event) {
      sendError(socket, "Invalid event JSON or unsupported event.");
      return;
    }
    switch (event.type) {
      case "JOIN":
        handleJoin(socket, state, event);
        break;
      case "MESSAGE":
        handleMessage(socket, state, event.message);
        break;
      case "PING":
        send(socket, { type: "PONG", sentAt: event.sentAt, serverAt: Date.now() });
        break;
      case "BAN_USER":
        handleBan(socket, state, event.targetId);
        break;
      case "ADMIN_SUBSCRIBE":
        if (!state.user?.isAdmin) {
          sendError(socket, "Administrator authorization is required for global monitoring.");
          break;
        }
        state.adminSubscribed = true;
        sendAdminSnapshot(socket);
        break;
      case "ADMIN_REFRESH":
        if (!state.user?.isAdmin || !state.adminSubscribed) {
          sendError(socket, "Administrator authorization is required for a global snapshot.");
          break;
        }
        sendAdminSnapshot(socket);
        break;
    }
  });
  socket.on("close", () => {
    const roomId = state.user?.roomId;
    clients.delete(socket);
    if (state.user) {
      broadcastRoom(roomId ?? null, { type: "USER_LEFT", userId: state.user.id });
      broadcastRoom(roomId ?? null, { type: "USERS", users: publicUsers(roomId ?? null) });
      updateAdminSubscribers();
    }
  });
  socket.on("error", (error) => {
    console.error("WebSocket client error:", error.message);
  });
});

const heartbeat = setInterval(() => {
  for (const [socket, state] of clients) {
    if (!state.isAlive) {
      socket.terminate();
      continue;
    }
    state.isAlive = false;
    socket.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Echo chat server listening on http://localhost:${PORT}`);
});

function shutdown(): void {
  clearInterval(heartbeat);
  for (const socket of clients.keys()) socket.close(1001, "Server shutting down.");
  wss.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
