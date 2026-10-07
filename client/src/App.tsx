import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Activity,
  Ban,
  Check,
  RefreshCw,
  LockKeyhole,
  MessageCircle,
  Radio,
  Send,
  ShieldCheck,
  Signal,
  UsersRound,
  Wifi,
  WifiOff,
} from "lucide-react";
import { decryptText, deriveRoomKey, encryptText } from "./crypto";
import type { AdminSnapshot, ChatMessage, ChatMessageDraft, ClientEvent, RenderedMessage, ServerEvent, User } from "./types";

const DEFAULT_SOCKET_URL = import.meta.env.VITE_WS_URL?.trim()
  || `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:3004/ws`;
const ADMIN_TOKEN_STORAGE_KEY = "echo-chat-admin-token";

function readStoredAdminToken(): { token: string; error: boolean } {
  try {
    return { token: window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "", error: false };
  } catch {
    return { token: "", error: true };
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function App() {
  const [storedAdminToken] = useState(readStoredAdminToken);
  const [nickname, setNickname] = useState("");
  const [roomIdInput, setRoomIdInput] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [adminToken, setAdminToken] = useState(storedAdminToken.token);
  const [rememberAdminToken, setRememberAdminToken] = useState(Boolean(storedAdminToken.token));
  const [socketUrl, setSocketUrl] = useState(DEFAULT_SOCKET_URL);
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [adminSnapshot, setAdminSnapshot] = useState<AdminSnapshot | null>(null);
  const [messages, setMessages] = useState<RenderedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState(storedAdminToken.error
    ? "This browser does not allow saving the administrator token."
    : "Choose a nickname to join the hub.");
  const [connected, setConnected] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [joining, setJoining] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const latencyTimerRef = useRef<number | null>(null);
  const welcomedRef = useRef(false);
  const pendingCloseReasonRef = useRef<string | null>(null);

  const updateAdminToken = (value: string) => {
    setAdminToken(value);
    if (!rememberAdminToken) return;
    try {
      if (value) window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, value);
      else window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    } catch {
      setRememberAdminToken(false);
      setStatus("Could not save the administrator token. Check browser storage settings.");
    }
  };

  const updateRememberAdminToken = (remember: boolean) => {
    try {
      if (remember && adminToken) window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
      if (!remember) window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      setRememberAdminToken(remember);
      setStatus(remember ? "Administrator token will be remembered on this device." : "Administrator token will not be remembered.");
    } catch {
      setRememberAdminToken(false);
      setStatus("Could not update saved credentials. Check browser storage settings.");
    }
  };

  const addIncomingMessage = useCallback(async (message: ChatMessage) => {
    let displayText = message.text;
    let decryptionFailed = false;
    if (message.isPrivate) {
      try {
        if (!keyRef.current || !message.iv) throw new Error("Room key is unavailable");
        displayText = await decryptText(message.text, message.iv, keyRef.current);
      } catch {
        displayText = "Unable to decrypt this message. Check the room passphrase.";
        decryptionFailed = true;
      }
    }
    setMessages((current) => [...current, { message, displayText, decryptionFailed }]);
  }, []);

  const leaveChat = useCallback((reason = "Disconnected.") => {
    if (latencyTimerRef.current !== null) window.clearInterval(latencyTimerRef.current);
    latencyTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    welcomedRef.current = false;
    pendingCloseReasonRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Client left chat.");
    keyRef.current = null;
    setConnected(false);
    setUser(null);
    setUsers([]);
    setAdminSnapshot(null);
    setMessages([]);
    setLatency(null);
    setJoining(false);
    setStatus(reason);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => () => {
    if (latencyTimerRef.current !== null) window.clearInterval(latencyTimerRef.current);
    socketRef.current?.close(1000, "Page closed.");
  }, []);

  const joinChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (joining || connected) return;
    const cleanNickname = nickname.trim();
    const roomId = roomIdInput.trim();
    if (!cleanNickname) {
      setStatus("Enter a nickname to continue.");
      return;
    }
    if (roomId && !passphrase) {
      setStatus("A passphrase is required for a protected room.");
      return;
    }

    setJoining(true);
    welcomedRef.current = false;
    pendingCloseReasonRef.current = null;
    setStatus(roomId ? "Deriving your room key securely…" : "Connecting to the public hub…");
    try {
      keyRef.current = roomId ? await deriveRoomKey(passphrase, roomId) : null;
      const socket = new WebSocket(socketUrl.trim());
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        const joinEvent: ClientEvent = {
          type: "JOIN",
          nickname: cleanNickname,
          ...(roomId ? { roomId } : {}),
          ...(adminToken.trim() ? { adminToken: adminToken.trim() } : {}),
        };
        socket.send(JSON.stringify(joinEvent));
      });
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        let serverEvent: ServerEvent;
        try {
          serverEvent = JSON.parse(event.data) as ServerEvent;
        } catch {
          setStatus("The server sent an invalid event.");
          return;
        }
        switch (serverEvent.type) {
          case "WELCOME":
            welcomedRef.current = true;
            setUser(serverEvent.user);
            setUsers(serverEvent.users);
            setAdminSnapshot(null);
            setConnected(true);
            setJoining(false);
            setPassphrase("");
            if (!rememberAdminToken) setAdminToken("");
            if (serverEvent.user.isAdmin) socket.send(JSON.stringify({ type: "ADMIN_SUBSCRIBE" } satisfies ClientEvent));
            setStatus(serverEvent.user.isAdmin
              ? "Connected · administrator access verified"
              : serverEvent.user.roomId
                ? "Connected · end-to-end encryption enabled"
                : "Connected · public messages are visible to the relay");
            latencyTimerRef.current = window.setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                const sentAt = Date.now();
                socket.send(JSON.stringify({ type: "PING", sentAt } satisfies ClientEvent));
              }
            }, 5_000);
            break;
          case "USERS":
            setUsers(serverEvent.users);
            break;
          case "USER_JOINED":
            setUsers((current) => current.some((person) => person.id === serverEvent.user.id) ? current : [...current, serverEvent.user]);
            break;
          case "USER_LEFT":
            setUsers((current) => current.filter((person) => person.id !== serverEvent.userId));
            break;
          case "ADMIN_SNAPSHOT":
            setAdminSnapshot(serverEvent.snapshot);
            break;
          case "MESSAGE":
            void addIncomingMessage(serverEvent.message);
            break;
          case "PONG":
            setLatency(Math.max(0, Date.now() - serverEvent.sentAt));
            break;
          case "ERROR":
            setStatus(serverEvent.message);
            if (!welcomedRef.current) {
              pendingCloseReasonRef.current = serverEvent.message;
              setJoining(false);
              keyRef.current = null;
              socket.close(1000, "Join rejected.");
            }
            break;
        }
      });
      socket.addEventListener("error", () => {
        pendingCloseReasonRef.current = "Could not connect. Check the server address and try again.";
        setStatus(pendingCloseReasonRef.current);
        socket.close();
        keyRef.current = null;
      });
      socket.addEventListener("close", (closeEvent: CloseEvent) => {
        if (socketRef.current !== socket) return;
        if (latencyTimerRef.current !== null) window.clearInterval(latencyTimerRef.current);
        latencyTimerRef.current = null;
        socketRef.current = null;
        welcomedRef.current = false;
        keyRef.current = null;
        setConnected(false);
        setJoining(false);
        setUser(null);
        setUsers([]);
        setAdminSnapshot(null);
        const rejectedReason = pendingCloseReasonRef.current;
        pendingCloseReasonRef.current = null;
        setStatus(rejectedReason ?? (closeEvent.code === 1008 ? closeEvent.reason || "Access denied by chat policy." : "Connection closed. Join again to reconnect."));
      });
    } catch (error) {
      keyRef.current = null;
      setJoining(false);
      setStatus(error instanceof Error ? error.message : "Could not prepare the room key.");
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    const socket = socketRef.current;
    if (!text || !user || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (new TextEncoder().encode(text).byteLength > 12_000) {
      setStatus("Messages are limited to 12,000 UTF-8 bytes.");
      return;
    }
    try {
      const message: ChatMessageDraft = {
        id: window.crypto.randomUUID(),
        author: user.nickname,
        sentAt: new Date().toISOString(),
        text,
        isPrivate: Boolean(user.roomId),
        ...(user.roomId ? { roomId: user.roomId } : {}),
      };
      if (user.roomId) {
        if (!keyRef.current) throw new Error("The room encryption key is not available.");
        const encrypted = await encryptText(text, keyRef.current);
        message.text = encrypted.text;
        message.iv = encrypted.iv;
      }
      const outgoing: ClientEvent = { type: "MESSAGE", message };
      socket.send(JSON.stringify(outgoing));
      setDraft("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send this message.");
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const banUser = (target: User) => {
    if (!user?.isAdmin || !socketRef.current || target.id === user.id) return;
    socketRef.current.send(JSON.stringify({ type: "BAN_USER", targetId: target.id } satisfies ClientEvent));
  };

  const refreshAdminSnapshot = () => {
    if (!user?.isAdmin || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "ADMIN_REFRESH" } satisfies ClientEvent));
  };

  if (!connected || !user) {
    return (
      <main className="page-shell">
        <header className="brand-header">
          <div className="brand-mark"><Radio size={20} /></div>
          <span>echo<span className="brand-accent">/</span>relay</span>
          <span className="header-label">REAL-TIME CHAT</span>
        </header>
        <section className="join-layout">
          <div className="intro">
            <div className="eyebrow"><span className="live-dot" /> OPEN CHANNEL</div>
            <h1>Words travel.<br /><span>Privacy stays.</span></h1>
            <p>A lightweight real-time echo hub, with passphrase-protected rooms that keep message contents private from the server.</p>
            <div className="intro-proof">
              <div><ShieldCheck size={17} /><span>End-to-end encrypted rooms</span></div>
              <div><Activity size={17} /><span>Low-latency WebSocket relay</span></div>
            </div>
          </div>

          <form className="join-card" onSubmit={(event) => void joinChat(event)}>
            <div className="card-heading">
              <div className="card-icon"><MessageCircle size={19} /></div>
              <div><h2>Join the conversation</h2><p>Pick a name and choose your channel.</p></div>
            </div>
            <label className="field-label" htmlFor="nickname">NICKNAME</label>
            <input id="nickname" className="text-input" maxLength={24} autoComplete="nickname" placeholder="e.g. alex" value={nickname} onChange={(event) => setNickname(event.target.value)} required />
            <label className="field-label" htmlFor="socket-url">SERVER ADDRESS</label>
            <input id="socket-url" className="text-input mono-input" value={socketUrl} onChange={(event) => setSocketUrl(event.target.value)} required />

            <div className="mode-heading">
              <span className="field-label">CHANNEL</span>
              <span className="mode-note">{roomIdInput.trim() ? "PROTECTED ROOM" : "PUBLIC HUB"}</span>
            </div>
            <label className="field-label" htmlFor="room-id">ROOM ID <span className="optional">· OPTIONAL</span></label>
            <input id="room-id" className="text-input" maxLength={64} autoComplete="off" placeholder="Leave empty to join the public hub" value={roomIdInput} onChange={(event) => setRoomIdInput(event.target.value)} />
            {roomIdInput.trim() && <>
              <label className="field-label" htmlFor="passphrase">ROOM PASSPHRASE</label>
              <input id="passphrase" className="text-input" type="password" autoComplete="new-password" placeholder="Never sent to the server" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required />
              <p className="field-help"><LockKeyhole size={13} /> Your key is derived in this browser and is never transmitted.</p>
            </>}
            <details className="admin-access">
              <summary>Administrator credentials</summary>
              <label className="field-label" htmlFor="admin-token">SERVER ADMIN TOKEN</label>
              <input id="admin-token" className="text-input" type="password" autoComplete="off" placeholder="Optional · configured by server operator" value={adminToken} onChange={(event) => updateAdminToken(event.target.value)} />
              <label className="remember-token">
                <input type="checkbox" checked={rememberAdminToken} onChange={(event) => updateRememberAdminToken(event.target.checked)} />
                <span>Remember token on this device</span>
              </label>
              <p className="field-help token-storage-note">Stored in this browser only. Anyone using this account can access the token.</p>
              <button className="admin-shortcut" type="button" onClick={() => setNickname("admin")}>Use nickname “admin”</button>
            </details>
            <button className="primary-button" type="submit" disabled={joining}>
              {joining ? <><span className="spinner" /> CONNECTING…</> : <>ENTER CHAT <Send size={16} /></>}
            </button>
            <p className="connection-status"><span className={joining ? "status-dot connecting" : "status-dot"} />{status}</p>
          </form>
        </section>
        <footer className="page-footer"><span>ZERO-KNOWLEDGE BY DESIGN</span><span>PBKDF2 · AES-GCM 256</span></footer>
      </main>
    );
  }

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <div className="brand-lockup"><div className="brand-mark"><Radio size={19} /></div><span>echo<span className="brand-accent">/</span>relay</span></div>
        <div className="channel-indicator"><span className="live-dot" /><span>{user.roomId ? `ROOM / ${user.roomId}` : "PUBLIC HUB"}</span>{user.roomId && <LockKeyhole size={14} />}</div>
        <div className="header-user"><span className="avatar">{user.nickname.charAt(0).toUpperCase()}</span><span>{user.nickname}</span>{user.isAdmin && <span className="admin-badge">ADMIN</span>}<button className="leave-button" onClick={() => leaveChat("You left the conversation.")}>LEAVE</button></div>
      </header>
      {user.isAdmin && <section className="admin-global-panel" aria-label="Global administrator control panel">
        <div className="admin-panel-heading">
          <div><div className="admin-panel-title"><ShieldCheck size={16} /><h2>GLOBAL ADMINISTRATION</h2></div>
            <p>All connected users and active rooms · authorized server-side</p></div>
          <button className="admin-refresh" type="button" onClick={refreshAdminSnapshot}><RefreshCw size={14} /> REFRESH</button>
        </div>
        {!adminSnapshot ? <p className="admin-loading">Loading the global connected-user snapshot…</p> : <div className="admin-global-content">
          <div className="admin-rooms">
            <h3>ACTIVE ROOMS <span>{adminSnapshot.rooms.length}</span></h3>
            {adminSnapshot.rooms.length === 0 ? <p className="admin-empty">No active rooms.</p> : adminSnapshot.rooms.map((room) => <div className="admin-room-row" key={room.roomId ?? "public-hub"}>
              <span className="room-name">{room.roomId ?? "Public Hub"}</span><span className="room-count">{room.userCount} {room.userCount === 1 ? "user" : "users"}</span>
            </div>)}
          </div>
          <div className="admin-users">
            <h3>CONNECTED USERS <span>{adminSnapshot.users.length}</span></h3>
            {adminSnapshot.users.length === 0 ? <p className="admin-empty">No connected users.</p> : <div className="admin-user-list">
              {adminSnapshot.users.map((person) => <div className="admin-user-row" key={person.id}>
                <span className="avatar small">{person.nickname.charAt(0).toUpperCase()}</span>
                <span className="admin-user-name">{person.nickname}{person.id === user.id ? " (you)" : ""}</span>
                <span className="admin-user-room">{person.roomId ?? "Public Hub"}</span>
                {person.isAdmin && <span className="admin-user-badge"><ShieldCheck size={12} /> ADMIN</span>}
                {person.id !== user.id && <button className="ban-button global-ban-button" title={`Ban ${person.nickname} globally`} aria-label={`Ban ${person.nickname} globally`} onClick={() => banUser(person)}><Ban size={14} /><span>BAN</span></button>}
              </div>)}
            </div>}
          </div>
        </div>}
      </section>}
      <div className="chat-content">
        <aside className="people-panel">
          <div className="panel-title"><UsersRound size={16} /><span>IN THIS CHANNEL</span><span className="people-count">{users.length}</span></div>
          <div className="people-list">
            {users.map((person) => <div className="person-row" key={person.id}>
              <span className={`avatar small ${person.id === user.id ? "self-avatar" : ""}`}>{person.nickname.charAt(0).toUpperCase()}</span>
              <span className="person-name">{person.nickname}{person.id === user.id ? " (you)" : ""}</span>
              {person.isAdmin && <ShieldCheck size={14} className="admin-icon" />}
              {user.isAdmin && person.id !== user.id && <button className="ban-button" title={`Ban ${person.nickname}`} aria-label={`Ban ${person.nickname}`} onClick={() => banUser(person)}><Ban size={14} /></button>}
            </div>)}
          </div>
          <div className="security-card">
            {user.roomId ? <LockKeyhole size={17} /> : <Signal size={17} />}
            <div><strong>{user.roomId ? "Private room" : "Hub relay"}</strong><p>{user.roomId ? "Messages encrypted before relay." : "Messages are visible to the hub."}</p></div>
            {user.roomId && <Check size={15} className="security-check" />}
          </div>
          <div className="network-stat"><span><Activity size={14} /> LATENCY</span><strong>{latency === null ? "—" : `${latency} ms`}</strong></div>
        </aside>
        <section className="conversation">
          <div className="conversation-title"><div><h1>{user.roomId ? user.roomId : "The public hub"}</h1><p>{user.roomId ? "Messages are end-to-end encrypted" : "A live echo channel · messages relay in real time"}</p></div><div className="online-tag"><span className="live-dot" /> ONLINE</div></div>
          <div className="message-list" ref={scrollRef} aria-live="polite">
            {messages.length === 0 ? <div className="empty-state"><div className="empty-icon"><MessageCircle size={23} /></div><h2>Room is quiet</h2><p>Send the first message to get the conversation started.</p></div> :
              messages.map(({ message, displayText, decryptionFailed }) => <article className={`message-row ${message.author === user.nickname ? "own-message" : ""}`} key={message.id}>
                <span className="avatar message-avatar">{message.author.charAt(0).toUpperCase()}</span>
                <div className="message-body"><div className="message-meta"><strong>{message.author}</strong><time dateTime={message.sentAt}>{formatTime(message.sentAt)}</time>{message.isPrivate && <LockKeyhole size={12} className="message-lock" />}</div>
                  <div className={`message-bubble ${decryptionFailed ? "failed-message" : ""}`}>{displayText}</div>
                  <div className="message-received">RECEIVED {formatTime(message.receivedAt)}</div>
                </div>
              </article>)}
          </div>
          <form className="composer" onSubmit={(event) => void sendMessage(event)}>
            <textarea aria-label="Write a message" rows={1} maxLength={12_000} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={user.roomId ? "Write an encrypted message…" : "Write a message to the hub…"} />
            <div className="composer-foot"><span>{user.roomId ? <><LockKeyhole size={13} /> END-TO-END ENCRYPTED</> : <><Wifi size={13} /> LIVE RELAY</>} · ENTER TO SEND</span><button type="submit" aria-label="Send message" disabled={!draft.trim()}><Send size={17} /></button></div>
          </form>
        </section>
      </div>
      <footer className="chat-footer"><span>{user.isAdmin ? <ShieldCheck size={13} /> : <WifiOff size={13} />}{status}</span><span>{user.roomId ? "AES-GCM 256 · PBKDF2 SHA-256" : "RFC 6455 · ECHO RELAY"}</span></footer>
    </main>
  );
}

export default App;
