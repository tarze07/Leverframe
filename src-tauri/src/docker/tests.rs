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

// ---- D2: changes, jobs ----

use std::sync::{Arc, Condvar, Mutex};

use super::actions::{home_volume_name, plan, valid_name, ContainerSpec, EnvVar};
use super::jobs::{build_args, logs_args, pull_args};
use super::{DockerJobs, JobEvent, JobEvents};

fn spec(dir: &std::path::Path) -> ContainerSpec {
    ContainerSpec {
        image: "leverframe-agents:0.8.0".into(),
        name: "sklep-agenci".into(),
        project_dir: Some(dir.to_string_lossy().into_owned()),
        home_volume: true,
        home_dir: "/home/agent".into(),
        ..Default::default()
    }
}

fn project() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lf-docker-project-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_new_container_is_planned_and_checked() {
    let dir = project();
    let p = plan(&spec(&dir)).unwrap();
    let mount = format!("{}:/workspace", dir.display());
    assert_eq!(
        p.args,
        [
            "run",
            "-d",
            "--name",
            "sklep-agenci",
            "--label",
            "io.leverframe.agents=1",
            "--init",
            "-v",
            &mount,
            "-v",
            "leverframe-sklep-agenci-home:/home/agent",
            "-w",
            "/workspace",
            "leverframe-agents:0.8.0",
            "sleep",
            "infinity"
        ]
    );
    assert_eq!(p.volume.as_deref(), Some("leverframe-sklep-agenci-home"));
    assert!(p.warnings.is_empty());
    assert!(p.command.starts_with("docker run -d --name sklep-agenci"));

    // Everything the form offers.
    let mut full = spec(&dir);
    full.env = vec![EnvVar {
        name: "NODE_ENV".into(),
        value: "development mode".into(),
    }];
    full.ports = vec![
        "8080:80".into(),
        "127.0.0.1:5173:5173/tcp".into(),
        " ".into(),
    ];
    full.network = Some("dev".into());
    full.user = Some("1000:1000".into());
    let p = plan(&full).unwrap();
    let tail: Vec<&str> = p.args.iter().map(String::as_str).skip(13).collect();
    assert_eq!(
        tail,
        [
            "-e",
            "NODE_ENV=development mode",
            "-p",
            "8080:80",
            "-p",
            "127.0.0.1:5173:5173/tcp",
            "--network",
            "dev",
            "-u",
            "1000:1000",
            "leverframe-agents:0.8.0",
            "sleep",
            "infinity"
        ]
    );
    assert!(p.warnings[0].contains("docker inspect"), "{:?}", p.warnings);
    assert!(
        p.command.contains("'NODE_ENV=development mode'"),
        "{}",
        p.command
    );

    // Without a folder or a volume.
    let bare = ContainerSpec {
        project_dir: None,
        home_volume: false,
        ..spec(&dir)
    };
    assert_eq!(plan(&bare).unwrap().args.len(), 12);

    // Refused.
    let bad = |f: &dyn Fn(&mut ContainerSpec)| {
        let mut s = spec(&dir);
        f(&mut s);
        plan(&s).unwrap_err()
    };
    assert!(bad(&|s| s.name = "-x".into()).contains("Nazwa"));
    assert!(bad(&|s| s.name = "a b".into()).contains("Nazwa"));
    assert!(bad(&|s| s.image = "".into()).contains("obraz"));
    assert!(bad(&|s| s.project_dir = Some("/nie/ma/takiego".into())).contains("nie istnieje"));
    assert!(bad(&|s| s.home_dir = "home".into()).contains("bezwzględna"));
    assert!(bad(&|s| s.network = Some("host".into())).contains("host"));
    assert!(bad(&|s| s.ports = vec!["99999".into()]).contains("port"));
    assert!(bad(&|s| s.ports = vec!["80:80/sctp".into()]).contains("port"));
    assert!(bad(&|s| s.user = Some("--privileged".into())).contains("użytkownik"));
    assert!(bad(&|s| s.env = vec![EnvVar {
        name: "A-B".into(),
        value: "1".into()
    }])
    .contains("zmiennej"));
    assert!(bad(&|s| s.env = vec![EnvVar {
        name: "A".into(),
        value: "1\n2".into()
    }])
    .contains("nowej linii"));

    // A home or root folder works, with a warning.
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    let p = plan(&ContainerSpec {
        project_dir: Some(root.into()),
        ..spec(&dir)
    })
    .unwrap();
    assert!(p.warnings[0].contains("cały folder"), "{:?}", p.warnings);

    assert_eq!(home_volume_name("x"), "leverframe-x-home");
    assert!(valid_name("a.b_c-1") && !valid_name(".a") && !valid_name(""));
    let _ = std::fs::remove_dir_all(dir);
}

fn logged(d: &Docker, log: &std::path::Path, f: impl FnOnce(&Docker)) -> Vec<String> {
    let _ = std::fs::remove_file(log);
    let d = d
        .clone()
        .with_env("FAKE_DOCKER_LOG", &log.to_string_lossy());
    f(&d);
    let calls = std::fs::read_to_string(log).unwrap_or_default();
    let _ = std::fs::remove_file(log);
    calls.lines().map(String::from).collect()
}

#[test]
fn containers_images_and_volumes_are_changed_with_exact_arguments() {
    let dir = project();
    let log = std::env::temp_dir().join(format!("lf-fake-docker-d2-{}.log", std::process::id()));
    let d = fake("ok");
    let calls = logged(&d, &log, |d| {
        assert!(d.create(&spec(&dir)).unwrap().starts_with("4f1d2e"));
    });
    assert_eq!(
        calls[0],
        "volume|create|--label|io.leverframe.agents=1|leverframe-sklep-agenci-home"
    );
    assert!(
        calls[1].starts_with("run|-d|--name|sklep-agenci|"),
        "{calls:?}"
    );

    let calls = logged(&d, &log, |d| {
        d.start("sklep-agenci").unwrap();
        d.stop("sklep-agenci").unwrap();
        d.restart("sklep-agenci").unwrap();
        d.remove("sklep-agenci", false).unwrap();
        d.remove("sklep-agenci", true).unwrap();
        d.remove_image("node:22").unwrap();
        d.remove_volume("leverframe-sklep-agenci-home").unwrap();
        assert_eq!(d.prune_images().unwrap(), "Total reclaimed space: 1.2GB");
    });
    assert_eq!(
        calls,
        [
            "start|--|sklep-agenci",
            "stop|--|sklep-agenci",
            "restart|--|sklep-agenci",
            "rm|--|sklep-agenci",
            "rm|--force|--|sklep-agenci",
            "rmi|--|node:22",
            "volume|rm|--|leverframe-sklep-agenci-home",
            "image|prune|--all|--force"
        ]
    );
    assert_eq!(
        d.stop("nie-ma").unwrap_err(),
        DockerError::NoSuchObject("nie-ma".into())
    );
    for bad in ["--all", "a b"] {
        assert!(
            d.start(bad).is_err() && d.remove_image(bad).is_err() && d.remove_volume(bad).is_err()
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[derive(Default)]
struct Collector {
    events: Mutex<Vec<JobEvent>>,
    changed: Condvar,
}

impl JobEvents for Collector {
    fn emit(&self, event: JobEvent) {
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
    }
}

impl Collector {
    fn wait(&self, pred: impl Fn(&[JobEvent]) -> bool) -> Vec<JobEvent> {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut events = self.events.lock().unwrap();
        while !pred(&events) {
            let left = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("timeout waiting for job events");
            events = self.changed.wait_timeout(events, left).unwrap().0;
        }
        events.clone()
    }
    fn lines(events: &[JobEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                JobEvent::Line { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }
}

fn done(events: &[JobEvent]) -> bool {
    matches!(events.last(), Some(JobEvent::Done { .. }))
}

#[test]
fn pulls_builds_and_follows_logs_as_jobs() {
    let jobs = DockerJobs::default();
    let d = fake("ok");

    let pull = Arc::new(Collector::default());
    jobs.start(&d, &pull_args("node:22").unwrap(), pull.clone())
        .unwrap();
    let events = pull.wait(done);
    assert_eq!(
        Collector::lines(&events).last().unwrap(),
        "Status: Downloaded newer image for node:22"
    );
    assert_eq!(
        events.last().unwrap(),
        &JobEvent::Done {
            ok: true,
            message: None
        }
    );

    let failed = Arc::new(Collector::default());
    jobs.start(&d, &pull_args("nope:1").unwrap(), failed.clone())
        .unwrap();
    match failed.wait(done).last().unwrap() {
        JobEvent::Done {
            ok: false,
            message: Some(m),
        } => assert!(m.contains("pull access denied"), "{m}"),
        e => panic!("{e:?}"),
    }

    // Build output comes on stderr (BuildKit), as lines like the rest.
    let dir = project();
    std::fs::write(dir.join("Dockerfile"), "FROM node:22\n").unwrap();
    let build = Arc::new(Collector::default());
    let args = build_args(&dir.to_string_lossy(), "moj-obraz:1.0", None).unwrap();
    jobs.start(&d, &args, build.clone()).unwrap();
    let events = build.wait(done);
    assert!(Collector::lines(&events)
        .iter()
        .any(|l| l.contains("naming to docker.io/library/moj-obraz:1.0")));
    assert!(matches!(
        events.last(),
        Some(JobEvent::Done { ok: true, .. })
    ));

    // Logs follow until stopped.
    let logs = Arc::new(Collector::default());
    let id = jobs
        .start(&d, &logs_args("sklep-agenci").unwrap(), logs.clone())
        .unwrap();
    logs.wait(|e| Collector::lines(e).len() == 2);
    assert_eq!(jobs.count(), 1);
    jobs.cancel(id);
    let events = logs.wait(done);
    assert_eq!(
        events.last().unwrap(),
        &JobEvent::Done {
            ok: false,
            message: Some("Przerwano".into())
        }
    );
    assert_eq!(jobs.count(), 0);
    jobs.cancel(id); // finished: nothing happens

    // Checked before anything runs.
    assert!(pull_args("--all").is_err());
    assert!(build_args("/nie/ma", "x:1", None)
        .unwrap_err()
        .contains("nie istnieje"));
    assert!(
        build_args(&dir.to_string_lossy(), "x:1", Some("Inny.Dockerfile"))
            .unwrap_err()
            .contains("Brak pliku")
    );
    assert!(build_args(&dir.to_string_lossy(), "zły tag", None).is_err());
    assert!(logs_args("-f").is_err());
    assert!(matches!(
        jobs.start(
            &Docker::new("leverframe-no-such-docker-program"),
            &pull_args("x").unwrap(),
            Arc::new(Collector::default())
        ),
        Err(DockerError::NotInstalled(_))
    ));
    let _ = std::fs::remove_dir_all(dir);
}

/// The whole cycle on the real Docker (Linux containers): pull, create with the project folder
/// and a home volume, mounts, stop / start / restart, logs, removal. Skipped without Docker.
#[test]
fn real_docker_container_cycle_when_available() {
    let d = Docker::new("docker");
    let info = d.info();
    if !info.running || info.server_os.as_deref() != Some("linux") {
        eprintln!("Docker with Linux containers not available, skipped");
        return;
    }
    let jobs = DockerJobs::default();
    let image = "busybox:1.36";
    let pulled = Arc::new(Collector::default());
    jobs.start(&d, &pull_args(image).unwrap(), pulled.clone())
        .unwrap();
    match pulled.wait(done).last().unwrap() {
        JobEvent::Done { ok: true, .. } => {}
        e => {
            eprintln!("busybox could not be pulled ({e:?}), skipped");
            return;
        }
    }
    let dir = project();
    std::fs::write(dir.join("README.md"), "projekt\n").unwrap();
    let name = format!("lf-test-{}", std::process::id());
    let spec = ContainerSpec {
        image: image.into(),
        name: name.clone(),
        project_dir: Some(dir.to_string_lossy().into_owned()),
        home_volume: true,
        home_dir: "/root".into(),
        ..Default::default()
    };
    let _ = d.remove(&name, true);
    let id = d.create(&spec).unwrap();
    let cleanup = |d: &Docker| {
        let _ = d.remove(&name, true);
        let _ = d.remove_volume(&home_volume_name(&name));
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let c = d.inspect(&name).unwrap();
        assert!(id.starts_with(&c.id[..12]) && c.running && c.leverframe);
        assert_eq!(c.working_dir.as_deref(), Some("/workspace"));
        let workspace = c
            .mounts
            .iter()
            .find(|m| m.destination == "/workspace")
            .unwrap();
        assert_eq!(workspace.kind, "bind");
        let home = c.mounts.iter().find(|m| m.destination == "/root").unwrap();
        assert_eq!(home.name.as_deref(), Some(home_volume_name(&name).as_str()));
        assert!(d
            .volumes()
            .unwrap()
            .iter()
            .any(|v| v.name == home_volume_name(&name) && v.leverframe));
        assert!(d
            .containers()
            .unwrap()
            .iter()
            .any(|x| x.name == name && x.leverframe && x.state == "running"));

        d.stop(&name).unwrap();
        assert!(!d.inspect(&name).unwrap().running);
        d.start(&name).unwrap();
        d.restart(&name).unwrap();
        assert!(d.inspect(&name).unwrap().running);

        let logs = Arc::new(Collector::default());
        let job = jobs
            .start(&d, &logs_args(&name).unwrap(), logs.clone())
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        jobs.cancel(job);
        assert!(matches!(
            logs.wait(done).last(),
            Some(JobEvent::Done { ok: false, .. })
        ));

        d.remove(&name, true).unwrap();
        assert!(matches!(
            d.inspect(&name),
            Err(DockerError::NoSuchObject(_))
        ));
        d.remove_volume(&home_volume_name(&name)).unwrap();
    }));
    cleanup(&d);
    let _ = std::fs::remove_dir_all(dir);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}
