//! Standalone WebSocket bridge for testing the Chrome extension without the
//! desktop UI or audio. Reads commands from stdin, prints events to stdout.
//!
//!   cargo run --example bridge_server -- 47821 TEST-TOKE-N123-4567
//!
//! Commands:  start <session> | stop | text <seq> <words…>
//!            | typing <seq> <final words>|<provisional words> | quit

use live_caption_overlay_lib::bridge::Bridge;
use std::io::BufRead;
use std::sync::Arc;

fn main() {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(47821);
    let token = args.next().unwrap_or_else(|| "TEST-TOKE-N123-4567".into());
    let bridge = Bridge::new(Arc::new(|event, payload| {
        println!("{}", serde_json::json!({ "event": event, "payload": payload }));
    }));
    bridge.restart(port, &token);
    let mut session = 0u64;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let mut parts = line.trim().splitn(3, ' ');
        match parts.next() {
            Some("start") => {
                session = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1);
                bridge.set_state(true, session);
                println!("{}", serde_json::json!({ "event": "started", "session": session }));
            }
            Some("stop") => {
                bridge.set_state(false, session);
                println!("{}", serde_json::json!({ "event": "stopped" }));
            }
            Some("text") => {
                let seq: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let text = parts.next().unwrap_or("");
                let n = bridge.send_text(session, seq, text, None);
                println!("{}", serde_json::json!({ "event": "sent", "seq": seq, "clients": n }));
            }
            Some("typing") => {
                let seq: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let (text, provisional) = parts.next().unwrap_or("").split_once('|').unwrap_or(("", ""));
                let n = bridge.send_text(session, seq, text, Some(provisional));
                println!("{}", serde_json::json!({ "event": "sent", "seq": seq, "clients": n }));
            }
            Some("quit") => break,
            _ => {}
        }
    }
}
