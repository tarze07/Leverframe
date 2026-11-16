//! A stand-in for the `docker` CLI in tests: canned answers of `docker version`, `images`, `ps`,
//! `volume ls` and `inspect` in the formats Leverframe asks for. `FAKE_DOCKER_MODE` chooses a
//! scenario: `ok` (default), `down` (daemon not running), `denied` (no access to the socket),
//! `garbage` (output that is not JSON), `hang` (never answers). Changes (`run`, `start`, `rm`, …)
//! answer like Docker; `pull`, `build` and `logs --follow` stream their output (`pull` of an
//! image named `nope` fails, `logs --follow` waits until it is killed). `FAKE_DOCKER_LOG` appends every
//! argument list to a file (one line, arguments separated by `|`).

use std::io::Write;

const VERSION: &str = r#"{"Client":{"Version":"29.1.0","ApiVersion":"1.52","Os":"linux","Arch":"amd64"},"Server":{"Version":"29.1.0","ApiVersion":"1.52","Os":"linux","Arch":"amd64","KernelVersion":"6.8.0"}}"#;
const VERSION_CLIENT_ONLY: &str = r#"{"Client":{"Version":"29.1.0","ApiVersion":"1.52","Os":"linux","Arch":"amd64"},"Server":null}"#;
const IMAGES: &str = r#"{"Containers":"N/A","CreatedAt":"2026-11-10 09:00:00 +0100 CET","CreatedSince":"6 days ago","Digest":"<none>","ID":"1a2b3c4d5e6f","Repository":"leverframe-agents","SharedSize":"N/A","Size":"1.21GB","Tag":"0.8.0","UniqueSize":"N/A","VirtualSize":"1.21GB"}
{"Containers":"N/A","CreatedAt":"2026-10-01 12:00:00 +0200 CEST","CreatedSince":"6 weeks ago","Digest":"<none>","ID":"9f8e7d6c5b4a","Repository":"node","SharedSize":"N/A","Size":"226MB","Tag":"22-bookworm-slim","UniqueSize":"N/A","VirtualSize":"226MB"}
{"Containers":"N/A","CreatedAt":"2026-09-01 12:00:00 +0200 CEST","CreatedSince":"2 months ago","Digest":"<none>","ID":"0011aabbccdd","Repository":"<none>","SharedSize":"N/A","Size":"98MB","Tag":"<none>","UniqueSize":"N/A","VirtualSize":"98MB"}"#;
const PS: &str = r#"{"Command":"\"tini -- sleep infinity\"","CreatedAt":"2026-11-15 10:00:00 +0100 CET","ID":"c0ffee123456","Image":"leverframe-agents:0.8.0","Labels":"io.leverframe.agents=1,org.opencontainers.image.title=Leverframe agents","LocalVolumes":"1","Mounts":"/home/me/sklep,leverframe-sklep-home","Names":"sklep-agenci","Networks":"bridge","Ports":"","RunningFor":"20 hours ago","Size":"0B","State":"running","Status":"Up 20 hours"}
{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-11-01 08:00:00 +0100 CET","ID":"deadbeef0001","Image":"postgres:17","Labels":"","LocalVolumes":"1","Mounts":"pgdata","Names":"baza","Networks":"bridge","Ports":"0.0.0.0:5432->5432/tcp","RunningFor":"2 weeks ago","Size":"0B","State":"exited","Status":"Exited (0) 3 days ago"}"#;
const VOLUMES: &str = r#"{"Availability":"N/A","Driver":"local","Group":"N/A","Labels":"io.leverframe.agents=1","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/leverframe-sklep-home/_data","Name":"leverframe-sklep-home","Scope":"local","Size":"N/A","Status":"N/A"}
{"Availability":"N/A","Driver":"local","Group":"N/A","Labels":"","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/pgdata/_data","Name":"pgdata","Scope":"local","Size":"N/A","Status":"N/A"}"#;
const INSPECT: &str = r#"[{"Id":"c0ffee1234567890abcdef","Name":"/sklep-agenci","State":{"Status":"running","Running":true},"Config":{"Image":"leverframe-agents:0.8.0","User":"agent","WorkingDir":"/workspace","Labels":{"io.leverframe.agents":"1","org.opencontainers.image.title":"Leverframe agents"}},"Mounts":[{"Type":"bind","Source":"/home/me/sklep","Destination":"/workspace","Mode":"","RW":true,"Propagation":"rprivate"},{"Type":"volume","Name":"leverframe-sklep-home","Source":"/var/lib/docker/volumes/leverframe-sklep-home/_data","Destination":"/home/agent","Driver":"local","Mode":"z","RW":true,"Propagation":""}]}]"#;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(log) = std::env::var("FAKE_DOCKER_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
        {
            let _ = writeln!(f, "{}", args.join("|"));
        }
    }
    let mode = std::env::var("FAKE_DOCKER_MODE").unwrap_or_else(|_| "ok".into());
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match mode.as_str() {
        "hang" => loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        },
        "down" => {
            if words.first() == Some(&"version") {
                println!("{VERSION_CLIENT_ONLY}");
            }
            eprintln!("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
            std::process::exit(1);
        }
        "denied" => {
            if words.first() == Some(&"version") {
                println!("{VERSION_CLIENT_ONLY}");
            }
            eprintln!("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.52/version\": dial unix /var/run/docker.sock: connect: permission denied");
            std::process::exit(1);
        }
        "garbage" => {
            println!("to nie jest JSON");
            return;
        }
        _ => {}
    }
    let out = match words.as_slice() {
        ["version", "--format", _] => VERSION.to_string(),
        ["images", "--format", _] => IMAGES.to_string(),
        ["images", "--filter", "label=io.leverframe.agents=1", "--format", _] => {
            "1a2b3c4d5e6f".into()
        }
        ["ps", "--all", "--no-trunc", "--format", _] => PS.to_string(),
        ["volume", "ls", "--format", _] => VOLUMES.to_string(),
        ["inspect", "--type", "container", "--", "sklep-agenci" | "c0ffee123456"] => {
            INSPECT.to_string()
        }
        ["inspect", "--type", "container", "--", _] => {
            println!("[]");
            eprintln!("Error: No such container: {}", words[4]);
            std::process::exit(1);
        }
        ["run", "-d", ..] => {
            "4f1d2e3c5b6a79880000000000000000000000000000000000000000000000ab".into()
        }
        ["volume", "create", "--label", _, name] => name.to_string(),
        ["start" | "stop" | "restart" | "rmi", "--", name]
        | ["rm", "--", name]
        | ["rm", "--force", "--", name]
        | ["volume", "rm", "--", name] => {
            if *name == "nie-ma" {
                eprintln!("Error response from daemon: No such container: nie-ma");
                std::process::exit(1);
            }
            name.to_string()
        }
        ["image", "prune", "--all", "--force"] => {
            "Deleted Images:\nuntagged: node:20\n\nTotal reclaimed space: 1.2GB".into()
        }
        ["pull", "--", image] => {
            if image.starts_with("nope") {
                eprintln!("Error response from daemon: pull access denied for nope, repository does not exist or may require 'docker login'");
                std::process::exit(1);
            }
            for line in [
                "22: Pulling from library/node",
                "a1b2c3: Pull complete",
                "Digest: sha256:0123",
                &format!("Status: Downloaded newer image for {image}"),
            ] {
                println!("{line}");
            }
            return;
        }
        ["build", "--progress=plain", "-t", tag, "-f", _, "--", _] => {
            for line in [
                "#1 [internal] load build definition from Dockerfile",
                "#2 [1/2] FROM node:22",
                "#3 [2/2] RUN npm i -g @anthropic-ai/claude-code",
                &format!("#4 naming to docker.io/library/{tag} done"),
            ] {
                eprintln!("{line}");
            }
            return;
        }
        ["logs", "--follow", "--tail", "1000", "--", _] => {
            println!("start kontenera");
            println!("gotowy");
            let _ = std::io::stdout().flush();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
            }
        }
        _ => {
            eprintln!("fake docker: unknown command {}", words.join(" "));
            std::process::exit(125);
        }
    };
    println!("{out}");
}
