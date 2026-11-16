//! What Docker reports, as the UI gets it, and parsing of the CLI's `--format '{{json .}}'` output.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Label of images, containers and volumes made for Leverframe (`io.leverframe.agents=1`).
pub const LEVERFRAME_LABEL: &str = "io.leverframe.agents";

/// Whether Docker can be used, and if not, why.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerInfo {
    /// The `docker` program was found and ran.
    pub installed: bool,
    /// The daemon (Docker Engine / Docker Desktop) answers.
    pub running: bool,
    pub client_version: Option<String>,
    pub server_version: Option<String>,
    /// System of the daemon (`linux` also for Docker Desktop with Linux containers).
    pub server_os: Option<String>,
    /// Why Docker cannot be used (when `running` is false).
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    /// `None` for untagged images (`<none>`).
    pub repository: Option<String>,
    pub tag: Option<String>,
    /// As Docker shows it, e.g. `1.21GB`.
    pub size: String,
    pub created_at: String,
    pub created_since: String,
    /// Has the Leverframe label (an image with agents).
    pub leverframe: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    /// `running`, `exited`, `created`, `paused`, `restarting`, `removing`, `dead`.
    pub state: String,
    /// As Docker shows it, e.g. `Up 20 hours`.
    pub status: String,
    pub created_at: String,
    pub ports: String,
    pub labels: BTreeMap<String, String>,
    pub leverframe: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub labels: BTreeMap<String, String>,
    pub leverframe: bool,
}

/// A mount of a container: where its files are on this machine (`source`) and in the
/// container (`destination`). The base for mapping paths (D5).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMount {
    /// `bind`, `volume`, `tmpfs`, …
    pub kind: String,
    pub source: String,
    pub destination: String,
    /// Volume name (`volume` mounts).
    pub name: Option<String>,
    pub read_write: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetails {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub running: bool,
    /// User the container runs as (`None`: the image's default, usually root).
    pub user: Option<String>,
    pub working_dir: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub mounts: Vec<ContainerMount>,
    pub leverframe: bool,
}

fn is_leverframe(labels: &BTreeMap<String, String>) -> bool {
    labels
        .get(LEVERFRAME_LABEL)
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

/// Labels as `docker ps` / `volume ls` print them: `a=1,b=2`. (A value with a comma is cut at
/// it – only the Leverframe label, without commas, is read from lists; `inspect` has them all.)
pub fn parse_labels(s: &str) -> BTreeMap<String, String> {
    s.split(',')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let k = k.trim();
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn none_if_placeholder(s: String) -> Option<String> {
    (!s.is_empty() && s != "<none>").then_some(s)
}

/// One JSON object per line (the CLI's `--format '{{json .}}'`).
pub fn json_lines(output: &str) -> Result<Vec<Value>, String> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            serde_json::from_str::<Value>(l)
                .map_err(|_| format!("Docker zwrócił nieoczekiwane dane: {}", shorten(l)))
        })
        .collect()
}

pub fn shorten(s: &str) -> String {
    match s.char_indices().nth(120) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// `docker version --format '{{json .}}'`; the server part is `null` when the daemon is down.
pub fn parse_version(output: &str) -> (Option<String>, Option<String>, Option<String>) {
    let v: Value = json_lines(output)
        .ok()
        .and_then(|l| l.into_iter().next())
        .unwrap_or(Value::Null);
    let client = v["Client"]["Version"].as_str().map(String::from);
    let server = v["Server"]["Version"].as_str().map(String::from);
    let os = v["Server"]["Os"].as_str().map(String::from);
    (client, server, os)
}

pub fn parse_images(output: &str, leverframe_ids: &[String]) -> Result<Vec<DockerImage>, String> {
    Ok(json_lines(output)?
        .iter()
        .map(|v| {
            let id = text(v, "ID");
            DockerImage {
                leverframe: leverframe_ids.iter().any(|l| l == &id),
                repository: none_if_placeholder(text(v, "Repository")),
                tag: none_if_placeholder(text(v, "Tag")),
                size: text(v, "Size"),
                created_at: text(v, "CreatedAt"),
                created_since: text(v, "CreatedSince"),
                id,
            }
        })
        .collect())
}

pub fn parse_containers(output: &str) -> Result<Vec<DockerContainer>, String> {
    Ok(json_lines(output)?
        .iter()
        .map(|v| {
            let labels = parse_labels(&text(v, "Labels"));
            DockerContainer {
                id: text(v, "ID"),
                // Several names are comma-separated; the first is the container's own.
                name: text(v, "Names")
                    .split(',')
                    .next()
                    .unwrap_or_default()
                    .to_string(),
                image: text(v, "Image"),
                state: text(v, "State"),
                status: text(v, "Status"),
                created_at: text(v, "CreatedAt"),
                ports: text(v, "Ports"),
                leverframe: is_leverframe(&labels),
                labels,
            }
        })
        .collect())
}

pub fn parse_volumes(output: &str) -> Result<Vec<DockerVolume>, String> {
    Ok(json_lines(output)?
        .iter()
        .map(|v| {
            let labels = parse_labels(&text(v, "Labels"));
            DockerVolume {
                name: text(v, "Name"),
                driver: text(v, "Driver"),
                leverframe: is_leverframe(&labels),
                labels,
            }
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawMount {
    #[serde(default, rename = "Type")]
    kind: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    destination: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "RW")]
    rw: bool,
}

/// `docker inspect --type container <id>`: a JSON array with one object.
pub fn parse_inspect(output: &str) -> Result<ContainerDetails, String> {
    let all: Value = serde_json::from_str(output.trim()).map_err(|_| {
        format!(
            "Docker zwrócił nieoczekiwane dane: {}",
            shorten(output.trim())
        )
    })?;
    let v = all
        .as_array()
        .and_then(|a| a.first())
        .ok_or("Nie ma takiego kontenera")?;
    let labels: BTreeMap<String, String> = v["Config"]["Labels"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mounts = v["Mounts"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| serde_json::from_value::<RawMount>(m.clone()).ok())
                .map(|m| ContainerMount {
                    kind: m.kind,
                    source: m.source,
                    destination: m.destination,
                    name: m.name.filter(|n| !n.is_empty()),
                    read_write: m.rw,
                })
                .collect()
        })
        .unwrap_or_default();
    let non_empty = |s: &Value| s.as_str().filter(|s| !s.is_empty()).map(String::from);
    Ok(ContainerDetails {
        id: text(v, "Id"),
        name: text(v, "Name").trim_start_matches('/').to_string(),
        image: v["Config"]["Image"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        state: v["State"]["Status"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        running: v["State"]["Running"].as_bool().unwrap_or(false),
        user: non_empty(&v["Config"]["User"]),
        working_dir: non_empty(&v["Config"]["WorkingDir"]),
        leverframe: is_leverframe(&labels),
        labels,
        mounts,
    })
}
