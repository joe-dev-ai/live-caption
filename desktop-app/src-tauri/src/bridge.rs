//! Local WebSocket bridge to the companion Chrome extension.
//!
//! * Listens on 127.0.0.1 only.
//! * Browser pages cannot connect: any `Origin` other than
//!   `chrome-extension://…` is rejected during the handshake.
//! * The first message must be `{"type":"hello","token":"…"}` with the pairing
//!   token, within 5 s, or the connection is closed.
//! * Text is only forwarded while typing is active and only for the current
//!   session id, so nothing produced before a Stop can be typed after it.
//! * Two client roles: the extension's service worker types text ("typer");
//!   its speech page runs Chrome's speech recognition ("listener") on the
//!   captured audio, which is streamed to it only while listening is on.
//!
//! Protocol (JSON text frames; audio as binary frames of 16 kHz mono i16 LE):
//!   ext -> app : hello{token,version?,role?} | ping | ack{session,seq,result,detail}
//!                | speech{session,final,interim} | listener-status{state,mode,detail}   (listener)
//!   app -> ext : welcome{active,listen,session,lang} | auth_error{reason} | pong
//!                | state{active,listen,session,lang} | text{session,seq,text,provisional?}
//!                | <binary PCM>                                                       (listener)

use crate::settings::normalize_token;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
/// Clients ping every 20 s; drop them after this long without any message.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(65);

/// Receives bridge events: ("bridge-status", BridgeStatus), ("bridge-ack", ack),
/// ("bridge-speech", speech) and ("bridge-listener", listener status).
pub type EmitFn = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub listening: bool,
    pub port: u16,
    /// Connected extensions (typing side).
    pub clients: usize,
    /// Connected Chrome speech pages.
    pub listeners: usize,
    pub error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Typer,
    Listener,
}

struct Client {
    tx: mpsc::UnboundedSender<Message>,
    role: Role,
}

#[derive(Default, Clone)]
struct State {
    /// Text may be typed into Chrome.
    typing: bool,
    /// Audio is streamed to Chrome's speech recognition.
    listen: bool,
    session: u64,
    /// BCP 47 language for speech recognition, e.g. "en-US".
    lang: String,
}

impl State {
    fn message(&self, kind: &str) -> Value {
        json!({ "type": kind, "active": self.typing, "listen": self.listen, "session": self.session, "lang": self.lang })
    }
}

struct Inner {
    emit: EmitFn,
    token: RwLock<String>,
    clients: Mutex<HashMap<u64, Client>>,
    next_id: AtomicU64,
    state: Mutex<State>,
    status: Mutex<BridgeStatus>,
    server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Bridge {
    inner: Arc<Inner>,
}

impl Bridge {
    pub fn new(emit: EmitFn) -> Self {
        Self {
            inner: Arc::new(Inner {
                emit,
                token: RwLock::new(String::new()),
                clients: Mutex::default(),
                next_id: AtomicU64::new(1),
                state: Mutex::default(),
                status: Mutex::default(),
                server: Mutex::default(),
            }),
        }
    }

    /// (Re)start the server on `port` with `token`. Existing clients are
    /// disconnected so they re-authenticate with the current token.
    pub fn restart(&self, port: u16, token: &str) {
        *self.inner.token.write().unwrap() = normalize_token(token);
        if let Some(old) = self.inner.server.lock().unwrap().take() {
            old.abort();
        }
        for (_, client) in self.inner.clients.lock().unwrap().drain() {
            let _ = client.tx.send(Message::Close(None));
        }
        {
            let mut st = self.inner.status.lock().unwrap();
            *st = BridgeStatus {
                listening: false,
                port,
                clients: 0,
                listeners: 0,
                error: None,
            };
        }
        let inner = self.inner.clone();
        let handle = tauri::async_runtime::spawn(async move {
            match bind_with_retry(port).await {
                Ok(listener) => {
                    inner.update_status(|s| s.listening = true);
                    loop {
                        let Ok((stream, _)) = listener.accept().await else {
                            continue;
                        };
                        let inner = inner.clone();
                        tauri::async_runtime::spawn(async move { handle_connection(inner, stream).await });
                    }
                }
                Err(e) => inner.update_status(|s| {
                    s.listening = false;
                    s.error = Some(format!("Cannot listen on 127.0.0.1:{port}: {e}"));
                }),
            }
        });
        *self.inner.server.lock().unwrap() = Some(handle);
    }

    pub fn status(&self) -> BridgeStatus {
        self.inner.status.lock().unwrap().clone()
    }

    /// Update what the extension should do. `typing`: type text into Chrome;
    /// `listen`: run Chrome's speech recognition on the streamed audio.
    /// `session` changes on every Start so stale text from a previous session
    /// is ignored by both sides.
    pub fn set_state(&self, typing: bool, listen: bool, session: u64, lang: &str) {
        let msg = {
            let mut st = self.inner.state.lock().unwrap();
            *st = State {
                typing,
                listen,
                session,
                lang: lang.to_string(),
            };
            st.message("state")
        };
        self.inner.broadcast(msg, None);
    }

    /// Forward text to type. `text` is newly finalized caption text;
    /// `provisional` (live typing) is the complete not-yet-final tail that
    /// should follow it, replacing the tail typed before. Returns the number
    /// of clients it was sent to (0 when typing is inactive or the session is
    /// stale, so nothing can be typed after Stop).
    pub fn send_text(&self, session: u64, seq: u64, text: &str, provisional: Option<&str>) -> usize {
        {
            let st = self.inner.state.lock().unwrap();
            if !st.typing || st.session != session || (text.trim().is_empty() && provisional.is_none()) {
                return 0;
            }
        }
        let mut msg = json!({ "type": "text", "session": session, "seq": seq, "text": text });
        if let Some(p) = provisional {
            msg["provisional"] = json!(p);
        }
        self.inner.broadcast(msg, Some(Role::Typer))
    }

    /// Stream one packet of captured audio (16 kHz mono i16 LE) to Chrome's
    /// speech recognition. Only sent while listening is on; returns the
    /// number of speech pages it reached.
    pub fn send_audio(&self, pcm: &[u8]) -> usize {
        if !self.inner.state.lock().unwrap().listen {
            return 0;
        }
        let clients = self.inner.clients.lock().unwrap();
        clients
            .values()
            .filter(|c| c.role == Role::Listener)
            .filter(|c| c.tx.send(Message::binary(pcm.to_vec())).is_ok())
            .count()
    }
}

impl Inner {
    fn update_status(&self, f: impl FnOnce(&mut BridgeStatus)) {
        let snapshot = {
            let mut st = self.status.lock().unwrap();
            f(&mut st);
            let clients = self.clients.lock().unwrap();
            st.clients = clients.values().filter(|c| c.role == Role::Typer).count();
            st.listeners = clients.values().filter(|c| c.role == Role::Listener).count();
            st.clone()
        };
        (self.emit)("bridge-status", serde_json::to_value(snapshot).unwrap_or_default());
    }

    /// Send to every client, or only to clients with `role`.
    fn broadcast(&self, msg: Value, role: Option<Role>) -> usize {
        let text = msg.to_string();
        let clients = self.clients.lock().unwrap();
        clients
            .values()
            .filter(|c| role.map_or(true, |r| c.role == r))
            .filter(|c| c.tx.send(Message::text(text.clone())).is_ok())
            .count()
    }
}

/// Bind 127.0.0.1:`port`. When restarting on the same port, the previous
/// (aborted) listener may need a moment to release it, so retry briefly.
async fn bind_with_retry(port: u16) -> std::io::Result<TcpListener> {
    let mut attempts = 0;
    loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && attempts < 30 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            result => return result,
        }
    }
}

fn tokens_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // Constant-time comparison (length is not secret).
    a.len() == b.len() && !a.is_empty() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Handshake filter: reject anything that is not our extension. Web pages
/// always send an `Origin` header; local non-browser tools send none.
#[allow(clippy::result_large_err)] // signature required by tungstenite's Callback
fn check_origin(req: &Request, resp: Response) -> Result<Response, ErrorResponse> {
    match req.headers().get("origin").and_then(|o| o.to_str().ok()) {
        Some(origin) if !origin.starts_with("chrome-extension://") => {
            let mut err = ErrorResponse::new(Some("Origin not allowed".into()));
            *err.status_mut() = StatusCode::FORBIDDEN;
            Err(err)
        }
        _ => Ok(resp),
    }
}

async fn handle_connection(inner: Arc<Inner>, stream: TcpStream) {
    let Ok(Ok(ws)) =
        tokio::time::timeout(AUTH_TIMEOUT, tokio_tungstenite::accept_hdr_async(stream, check_origin)).await
    else {
        return;
    };
    let (mut sink, mut source) = ws.split();

    // --- Authentication -------------------------------------------------
    let hello = tokio::time::timeout(AUTH_TIMEOUT, source.next()).await;
    let hello = match hello {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(t.as_str())
            .ok()
            .filter(|v| v["type"] == "hello"),
        _ => None,
    };
    let authed = hello
        .as_ref()
        .and_then(|v| v["token"].as_str().map(normalize_token))
        .is_some_and(|tok| tokens_match(&tok, &inner.token.read().unwrap()));
    let role = match hello.as_ref().and_then(|v| v["role"].as_str()) {
        Some("listener") => Role::Listener,
        _ => Role::Typer,
    };
    if !authed {
        // Slow down guessing, then tell the extension why.
        tokio::time::sleep(Duration::from_millis(800)).await;
        let _ = sink
            .send(Message::text(
                json!({ "type": "auth_error", "reason": "bad_token" }).to_string(),
            ))
            .await;
        let _ = sink.close().await;
        return;
    }

    let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let mut welcome = inner.state.lock().unwrap().message("welcome");
    welcome["version"] = json!(env!("CARGO_PKG_VERSION"));
    let _ = tx.send(Message::text(welcome.to_string()));
    inner
        .clients
        .lock()
        .unwrap()
        .insert(id, Client { tx: tx.clone(), role });
    inner.update_status(|_| {});

    // --- Main loop --------------------------------------------------------
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    last_seen = Instant::now();
                    if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                        match v["type"].as_str() {
                            Some("ping") => { let _ = tx.send(Message::text(r#"{"type":"pong"}"#)); }
                            Some("ack") => (inner.emit)("bridge-ack", v),
                            Some("speech") if role == Role::Listener => (inner.emit)("bridge-speech", v),
                            Some("listener-status") if role == Role::Listener => (inner.emit)("bridge-listener", v),
                            _ => {}
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => last_seen = Instant::now(),
            },
            outgoing = rx.recv() => match outgoing {
                Some(msg) => if sink.send(msg).await.is_err() { break },
                None => break, // removed by restart()
            },
            _ = tick.tick() => if last_seen.elapsed() > CLIENT_TIMEOUT { break },
        }
    }
    inner.clients.lock().unwrap().remove(&id);
    inner.update_status(|_| {});
    let _ = sink.close().await;
}

#[cfg(test)]
mod tests {
    use super::tokens_match;

    #[test]
    fn token_compare() {
        assert!(tokens_match("ABCD-EFGH", "ABCD-EFGH"));
        assert!(!tokens_match("ABCD-EFGH", "ABCD-EFGX"));
        assert!(!tokens_match("", ""));
        assert!(!tokens_match("ABC", "ABCD"));
    }
}
