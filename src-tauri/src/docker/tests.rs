//! The Docker CLI layer against a fake `docker` (examples/fake_docker.rs) and, when Docker is
//! installed and running, against the real one (read only).

use std::time::Duration;

use super::cli::{classify, valid_reference};
use super::model::{parse_containers, parse_inspect, parse_labels, parse_version};
use super::{Docker, DockerError};

fn fake(mode: &str) -> Docker {
    Docker::new(crate::test_support::example("fake_docker").to_string_lossy())
        .with_env("FAKE_DOCKER_MODE", mode)
}

#[test]
fn reports_version_and_lists_resources() {
    let d = fake("ok");
    let info = d.info();
    assert!(info.installed && info.running, "{info:?}");
    assert_eq!(info.server_version.as_deref(), Some("29.1.0"));
    assert_eq!(info.server_os.as_deref(), Some("linux"));
    assert_eq!(info.message, None);

    let images = d.images().unwrap();
    assert_eq!(images.len(), 3);
    assert_eq!(images[0].repository.as_deref(), Some("leverframe-agents"));
    assert_eq!(images[0].tag.as_deref(), Some("0.8.0"));
    assert_eq!(images[0].size, "1.21GB");
    assert!(images[0].leverframe, "labelled image");
    assert!(!images[1].leverframe);
    assert_eq!(
        (images[2].repository.clone(), images[2].tag.clone()),
        (None, None),
        "<none>"
    );

    let containers = d.containers().unwrap();
    assert_eq!(containers.len(), 2);
    let c = &containers[0];
    assert_eq!(
        (c.name.as_str(), c.state.as_str()),
        ("sklep-agenci", "running")
    );
    assert!(c.leverframe);
    assert_eq!(
        c.labels["org.opencontainers.image.title"],
        "Leverframe agents"
    );
    assert_eq!(containers[1].state, "exited");
    assert!(!containers[1].leverframe);
    assert_eq!(containers[1].ports, "0.0.0.0:5432->5432/tcp");

    let volumes = d.volumes().unwrap();
    assert_eq!(volumes.iter().filter(|v| v.leverframe).count(), 1);
    assert_eq!(volumes[0].name, "leverframe-sklep-home");
}

#[test]
fn inspects_a_container_with_its_mounts() {
    let d = fake("ok");
    let c = d.inspect("sklep-agenci").unwrap();
    assert_eq!(c.name, "sklep-agenci", "without the leading slash");
    assert!(c.running && c.leverframe);
    assert_eq!(c.user.as_deref(), Some("agent"));
    assert_eq!(c.working_dir.as_deref(), Some("/workspace"));
    assert_eq!(c.mounts.len(), 2);
    let bind = &c.mounts[0];
    assert_eq!(
        (
            bind.kind.as_str(),
            bind.source.as_str(),
            bind.destination.as_str(),
            bind.read_write
        ),
        ("bind", "/home/me/sklep", "/workspace", true)
    );
    assert_eq!(c.mounts[1].name.as_deref(), Some("leverframe-sklep-home"));

    assert_eq!(
        d.inspect("nie-ma").unwrap_err(),
        DockerError::NoSuchObject("nie-ma".into())
    );
    // Never passed to the CLI as an option.
    for bad in ["--privileged", "", "a b", "x;rm", "ż"] {
        assert!(
            matches!(d.inspect(bad), Err(DockerError::Other(_))),
            "{bad}"
        );
    }
}

#[test]
fn arguments_are_passed_as_a_list_with_ids_after_double_dash() {
    let log = std::env::temp_dir().join(format!("lf-fake-docker-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&log);
    let d = fake("ok").with_env("FAKE_DOCKER_LOG", &log.to_string_lossy());
    d.inspect("sklep-agenci").unwrap();
    d.volumes().unwrap();
    let calls = std::fs::read_to_string(&log).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        [
            "inspect|--type|container|--|sklep-agenci",
            "volume|ls|--format|{{json .}}"
        ]
    );
    let _ = std::fs::remove_file(&log);
}

#[test]
fn explains_why_docker_cannot_be_used() {
    let down = fake("down").info();
    assert!(down.installed && !down.running);
    assert_eq!(down.client_version.as_deref(), Some("29.1.0"));
    assert!(down.message.unwrap().contains("Docker nie działa"));
    assert_eq!(fake("down").images().unwrap_err(), DockerError::NotRunning);

    let denied = fake("denied").info();
    assert!(!denied.running);
    assert!(denied.message.unwrap().contains("grupy docker"));
    assert_eq!(
        fake("denied").containers().unwrap_err(),
        DockerError::PermissionDenied
    );

    let missing = Docker::new("leverframe-no-such-docker-program").info();
    assert!(!missing.installed && !missing.running);
    assert!(missing.message.unwrap().contains("Nie znaleziono programu"));

    let garbage = fake("garbage").images().unwrap_err();
    assert!(
        garbage.to_string().contains("nieoczekiwane dane"),
        "{garbage}"
    );
    assert!(!fake("garbage").info().running);

    let hang = fake("hang").with_timeout(Duration::from_millis(500));
    assert_eq!(hang.volumes().unwrap_err(), DockerError::Timeout(0));
    assert!(!hang.info().running);
}

#[test]
fn errors_and_names_are_recognised() {
    assert_eq!(
        classify("error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.52/version\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.", Some(1)),
        DockerError::NotRunning,
        "Docker Desktop on Windows, not started"
    );
    assert_eq!(
        classify(
            "Error response from daemon: No such image: nginx:nope",
            Some(1)
        ),
        DockerError::NoSuchObject("nginx:nope".into())
    );
    assert_eq!(
        classify("", Some(3)),
        DockerError::Other("zakończył się kodem 3".into())
    );
    assert_eq!(
        classify("\n  boom\nmore", Some(1)),
        DockerError::Other("boom".into())
    );

    for ok in [
        "sklep-agenci",
        "c0ffee123456",
        "ghcr.io/org/img:1.0",
        "img@sha256:abc",
        "a_b.c",
    ] {
        assert!(valid_reference(ok), "{ok}");
    }
    for bad in ["", "-x", "a b", "a\nb", "a;b", "$(x)", &"a".repeat(300)] {
        assert!(!valid_reference(bad), "{bad}");
    }

    assert_eq!(
        parse_labels("a=1,b=,c"),
        [("a", "1"), ("b", ""), ("c", "")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    );
    assert!(parse_labels("").is_empty());
    assert_eq!(parse_version("nie json"), (None, None, None));
    assert!(parse_containers("").unwrap().is_empty(), "no containers");
    assert!(parse_inspect("[]").is_err());
}

/// The real Docker, read only; skipped when it is not installed or not running.
#[test]
fn real_docker_when_available() {
    let d = Docker::new("docker");
    let info = d.info();
    if !info.running {
        eprintln!("Docker not available, skipped: {:?}", info.message);
        return;
    }
    assert!(info.server_version.is_some());
    d.images().unwrap();
    let containers = d.containers().unwrap();
    d.volumes().unwrap();
    if let Some(c) = containers.first() {
        assert_eq!(d.inspect(&c.id).unwrap().id, c.id);
    }
    assert!(matches!(
        d.inspect("leverframe-no-such-container-42"),
        Err(DockerError::NoSuchObject(_))
    ));
}
