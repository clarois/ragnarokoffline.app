//! `ragnarok-stack agent <command> [args...]`: the command-line way for an AI
//! agent to play (#187).
//!
//! The app runs the game for the agent and listens on 127.0.0.1 (see
//! `electron/agent-api.js`); this is a thin client of that. It reads the port
//! and token the app wrote to `<state>/agent/connection.json`, sends one
//! command, and prints the JSON answer. Hand-rolled HTTP, like the rest of
//! this crate: one request to loopback needs nothing more.

use crate::json;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

const USAGE: &str = "usage: ragnarok-stack agent [--agent N] <command> [args...]

  login | characters | char <slot> | create <slot> <name>
  state [radius] | chat [all] | shot [name] | say <text> | walk <x> <y>
  whisper <name> <text> | party <text> | guild <text> | answer yes|no
  attack [gid|nearest] | interact <gid|name> | dialog | next | close | choose <n>
  skills [filter] | skill <id> [level] [--target <gid|nearest|self>] [--cell <x> <y>]
  equip <itemId> | hover <x> <y> [--px] | click <x> <y> [right] | key <key>
  wait <ms> | errors | status

Turn on Settings -> Population -> \"Let an AI agent play with me\" first.
The guide is AGENT.md, beside the connection file.";

pub fn run(state: &Path, args: &[String]) -> Result<(), String> {
    // `--agent N` picks which agent, when the player allows several.
    let mut agent: u32 = 1;
    let mut rest = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--agent" {
            agent = it
                .next()
                .and_then(|v| v.parse::<u32>().ok())
                .filter(|n| *n >= 1)
                .ok_or("--agent takes a number, 1 for the first agent")?;
        } else {
            rest.push(a.clone());
        }
    }
    let args = &rest[..];
    let Some(cmd) = args.first() else {
        println!("{USAGE}");
        return Ok(());
    };
    if cmd == "help" || cmd == "--help" {
        println!("{USAGE}");
        return Ok(());
    }
    let file = state.join("agent").join("connection.json");
    let text = std::fs::read_to_string(&file).map_err(|_| {
        format!(
            "{} is missing. Turn on \"Let an AI agent play with me\" in the app's settings (Population tab).",
            file.display()
        )
    })?;
    let conn = json::parse(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let port = match conn.get("port") {
        Some(json::Value::Number(n)) if *n >= 1.0 && *n <= 65535.0 => *n as u16,
        _ => return Err(format!("{}: no port", file.display())),
    };
    let token = conn.str("token").ok_or_else(|| format!("{}: no token", file.display()))?;

    let body = format!(
        "{{\"cmd\":{},\"agent\":{agent},\"args\":[{}]}}",
        json::quote(cmd),
        args[1..].iter().map(|a| json::quote(a)).collect::<Vec<_>>().join(",")
    );
    let (status, answer) = post(port, token, &body)?;
    println!("{answer}");
    if status == 200 {
        Ok(())
    } else if status == 401 {
        Err("the app refused the token; it may have been replaced. Nothing to do but run the command again once the app is open.".into())
    } else {
        Err(format!("the app answered {status}"))
    }
}

/// POST to the app's agent API. HTTP/1.0 and a closed connection, so the
/// answer is just "read until the end", with no chunking to undo.
fn post(port: u16, token: &str, body: &str) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|_| "the app is not listening. Is Ragnarok Offline open, with the AI agent turned on?".to_string())?;
    // Some commands wait on the game (a walk, a warp): allow for them.
    // Logging in again after a server restart can take a couple of minutes.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
    let request = format!(
        "POST /v1/command HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("reading the app's answer: {e}"))?;
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("the app's answer was cut short")?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("the app's answer had no status")?;
    Ok((status, body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_response_is_split_into_status_and_body() {
        let (status, body) = parse_response(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"ok\":true}");
        assert!(parse_response(b"HTTP/1.1 200 OK").is_err());
    }

    #[test]
    fn a_missing_connection_file_says_how_to_turn_the_agent_on() {
        let dir = std::env::temp_dir().join(format!("ro-agent-{}", std::process::id()));
        let err = run(&dir, &["state".to_string()]).unwrap_err();
        assert!(err.contains("Let an AI agent play with me"), "{err}");
    }
}
