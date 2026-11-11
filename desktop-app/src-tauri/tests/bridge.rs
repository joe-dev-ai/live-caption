//! Integration tests for the Chrome-extension WebSocket bridge.

use futures_util::{SinkExt, StreamExt};
use live_caption_overlay_lib::bridge::Bridge;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
const TOKEN: &str = "ABCD-EFGH-JKLM-NPQR";

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn start_bridge(port: u16) -> (Bridge, Events) {
    let events: Events = Arc::default();
    let ev = events.clone();
    let bridge = Bridge::new(Arc::new(move |name, payload| {
        ev.lock().unwrap().push((name.to_string(), payload))
    }));
    bridge.restart(port, TOKEN);
    (bridge, events)
}

async fn connect(port: u16, origin: Option<&str>) -> Result<Ws, String> {
    let mut req = format!("ws://127.0.0.1:{port}").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    // The server starts asynchronously; allow a slow (cold) start.
    for _ in 0..200 {
        match tokio_tungstenite::connect_async(req.clone()).await {
            Ok((ws, _)) => return Ok(ws),
            Err(tokio_tungstenite::tungstenite::Error::Io(_)) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("server did not start".into())
}

async fn recv(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) | Ok(Some(Err(_))) => return None,
            Ok(Some(Ok(_))) => continue,
        }
    }
}

/// Poll `cond` for up to 10 s.
async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

async fn hello(ws: &mut Ws, token: &str) -> Option<Value> {
    ws.send(Message::text(json!({ "type": "hello", "token": token }).to_string()))
        .await
        .unwrap();
    recv(ws).await
}

/// Next binary frame within `ms`, skipping text frames.
async fn recv_binary(ws: &mut Ws, ms: u64) -> Option<Vec<u8>> {
    loop {
        match tokio::time::timeout(Duration::from_millis(ms), ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => return Some(b.to_vec()),
            Ok(Some(Ok(Message::Text(_)))) => continue,
            _ => return None,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_web_page_origins() {
    let (_b, _) = start_bridge(48101);
    let err = connect(48101, Some("https://evil.example")).await.unwrap_err();
    assert!(err.contains("403"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_wrong_token() {
    let (b, _) = start_bridge(48102);
    let mut ws = connect(48102, Some("chrome-extension://abc")).await.unwrap();
    let reply = hello(&mut ws, "WRONG-TOKEN-0000-0000").await.unwrap();
    assert_eq!(reply["type"], "auth_error");
    assert!(recv(&mut ws).await.is_none(), "connection closed");
    assert!(eventually(|| b.status().clients == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn types_only_while_active_and_for_current_session() {
    let (b, events) = start_bridge(48103);
    let mut ws = connect(48103, Some("chrome-extension://abc")).await.unwrap();
    // Token comparison ignores case, spaces and dashes.
    let welcome = hello(&mut ws, "abcd efgh jklm npqr").await.unwrap();
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["active"], false);
    assert!(eventually(|| b.status().clients == 1).await);

    assert_eq!(b.send_text(1, 0, "too early", None), 0, "nothing sent before Start");
    b.set_state(true, false, 42, "en-US");
    assert_eq!(
        recv(&mut ws).await.unwrap(),
        json!({ "type": "state", "active": true, "listen": false, "session": 42, "lang": "en-US" })
    );
    assert_eq!(b.send_text(42, 1, "hello world", None), 1);
    assert_eq!(
        recv(&mut ws).await.unwrap(),
        json!({ "type": "text", "session": 42, "seq": 1, "text": "hello world" })
    );
    assert_eq!(b.send_text(41, 2, "stale session", Some("x")), 0);
    // Live typing: the provisional tail is forwarded, even with no final text
    // (an empty tail clears what was typed provisionally).
    assert_eq!(b.send_text(42, 2, "", Some("still speaking")), 1);
    assert_eq!(
        recv(&mut ws).await.unwrap(),
        json!({ "type": "text", "session": 42, "seq": 2, "text": "", "provisional": "still speaking" })
    );
    assert_eq!(b.send_text(42, 3, "", Some("")), 1);
    assert_eq!(recv(&mut ws).await.unwrap()["provisional"], "");
    assert_eq!(b.send_text(42, 4, "  ", None), 0, "nothing to type");

    b.set_state(false, false, 42, "en-US");
    assert_eq!(recv(&mut ws).await.unwrap()["active"], false);
    assert_eq!(
        b.send_text(42, 3, "after stop", Some("and more")),
        0,
        "nothing sent after Stop"
    );

    // Ping/pong and ack forwarding.
    ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
    assert_eq!(recv(&mut ws).await.unwrap()["type"], "pong");
    ws.send(Message::text(
        r#"{"type":"ack","session":42,"seq":1,"result":"inserted"}"#,
    ))
    .await
    .unwrap();
    assert!(
        eventually(|| events
            .lock()
            .unwrap()
            .iter()
            .any(|(n, v)| n == "bridge-ack" && v["result"] == "inserted"))
        .await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn new_token_disconnects_paired_clients() {
    let (b, _) = start_bridge(48104);
    let mut ws = connect(48104, None).await.unwrap();
    assert_eq!(hello(&mut ws, TOKEN).await.unwrap()["type"], "welcome");
    b.restart(48104, "ZZZZ-YYYY-XXXX-WWWW");
    assert!(recv(&mut ws).await.is_none(), "old client was disconnected");
    let mut ws2 = connect(48104, None).await.unwrap();
    assert_eq!(hello(&mut ws2, TOKEN).await.unwrap()["type"], "auth_error");
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_on_the_same_port_keeps_listening() {
    let (b, _) = start_bridge(48106);
    for _ in 0..10 {
        b.restart(48106, TOKEN);
    }
    let mut ws = connect(48106, None).await.unwrap();
    assert_eq!(hello(&mut ws, TOKEN).await.unwrap()["type"], "welcome");
    assert!(b.status().error.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_port_in_use() {
    let _hold = std::net::TcpListener::bind("127.0.0.1:48105").unwrap();
    let (b, _) = start_bridge(48105);
    assert!(eventually(|| b.status().error.is_some()).await);
    let st = b.status();
    assert!(!st.listening);
    assert!(st.error.unwrap_or_default().contains("48105"));
}

#[tokio::test(flavor = "multi_thread")]
async fn speech_page_gets_audio_only_while_listening_and_returns_speech() {
    let (b, events) = start_bridge(48107);
    let mut typer = connect(48107, Some("chrome-extension://abc")).await.unwrap();
    assert_eq!(hello(&mut typer, TOKEN).await.unwrap()["type"], "welcome");
    let mut listener = connect(48107, Some("chrome-extension://abc")).await.unwrap();
    listener
        .send(Message::text(
            json!({ "type": "hello", "token": TOKEN, "role": "listener" }).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(recv(&mut listener).await.unwrap()["type"], "welcome");
    assert!(eventually(|| b.status().listeners == 1 && b.status().clients == 1).await);

    assert_eq!(b.send_audio(&[1, 2, 3, 4]), 0, "not listening yet");
    b.set_state(true, true, 7, "en-US");
    let state = recv(&mut listener).await.unwrap();
    assert_eq!(
        (state["listen"].as_bool(), state["lang"].as_str()),
        (Some(true), Some("en-US"))
    );
    assert_eq!(b.send_audio(&[1, 2, 3, 4]), 1, "only the speech page gets audio");
    assert_eq!(recv_binary(&mut listener, 2000).await, Some(vec![1, 2, 3, 4]));
    assert_eq!(recv_binary(&mut typer, 300).await, None);

    // Recognized speech goes to the app; a typer cannot inject speech.
    let speech = json!({ "type": "speech", "session": 7, "final": "hello world", "interim": "how" });
    listener.send(Message::text(speech.to_string())).await.unwrap();
    typer
        .send(Message::text(
            json!({ "type": "speech", "session": 7, "final": "fake" }).to_string(),
        ))
        .await
        .unwrap();
    assert!(
        eventually(|| events
            .lock()
            .unwrap()
            .iter()
            .any(|(n, v)| n == "bridge-speech" && v["final"] == "hello world"))
        .await
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!events.lock().unwrap().iter().any(|(_, v)| v["final"] == "fake"));

    b.set_state(true, false, 7, "en-US");
    assert_eq!(b.send_audio(&[5, 6]), 0, "stopped listening");
}
