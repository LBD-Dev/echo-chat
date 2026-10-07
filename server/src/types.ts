export interface User {
  id: string;
  nickname: string;
  roomId: string | null;
  isAdmin: boolean;
}

export interface AdminRoom {
  roomId: string | null;
  userCount: number;
}

export interface AdminSnapshot {
  rooms: AdminRoom[];
  users: User[];
}

export interface ChatMessage {
  id: string;
  author: string;
  sentAt: string;
  receivedAt: string;
  text: string;
  isPrivate: boolean;
  roomId?: string;
  iv?: string;
}

export type ChatMessageDraft = Omit<ChatMessage, "receivedAt">;

export type ClientEvent =
  | { type: "JOIN"; nickname: string; roomId?: string; adminToken?: string }
  | { type: "MESSAGE"; message: ChatMessageDraft }
  | { type: "PING"; sentAt: number }
  | { type: "BAN_USER"; targetId: string }
  | { type: "ADMIN_SUBSCRIBE" }
  | { type: "ADMIN_REFRESH" };

export type ServerEvent =
  | { type: "WELCOME"; user: User; users: User[] }
  | { type: "USERS"; users: User[] }
  | { type: "USER_JOINED"; user: User }
  | { type: "USER_LEFT"; userId: string }
  | { type: "ADMIN_SNAPSHOT"; snapshot: AdminSnapshot }
  | { type: "MESSAGE"; message: ChatMessage }
  | { type: "PONG"; sentAt: number; serverAt: number }
  | { type: "ERROR"; message: string };
