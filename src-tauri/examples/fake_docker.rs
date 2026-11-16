//! A stand-in for the `docker` CLI in tests: canned answers of `docker version`, `images`, `ps`,
//! `volume ls` and `inspect` in the formats Leverframe asks for. `FAKE_DOCKER_MODE` chooses a
//! scenario: `ok` (default), `down` (daemon not running), `denied` (no access to the socket),
//! `garbage` (output that is not JSON), `hang` (never answers). `FAKE_DOCKER_LOG` appends every
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
        _ => {
            eprintln!("fake docker: unknown command {}", words.join(" "));
            std::process::exit(125);
        }
    };
    println!("{out}");
}
