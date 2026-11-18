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
        // Other tests may remove their containers meanwhile.
        match d.inspect(&c.id) {
            Ok(details) => assert_eq!(details.id, c.id),
            Err(DockerError::NoSuchObject(_)) => {}
            Err(e) => panic!("{e}"),
        }
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

/// A project folder of its own for each test (tests run in parallel and remove their folder).
fn project(test: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("lf-docker-project-{test}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_new_container_is_planned_and_checked() {
    let dir = project("a_new_container_is_plann");
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
    // Only the owner of the folder may matter here (it depends on who runs the tests).
    assert!(
        p.warnings
            .iter()
            .all(|w| w.starts_with("Folder projektu należy")),
        "{:?}",
        p.warnings
    );
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
    let dir = project("containers_images_and_vo");
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
    let dir = project("pulls_builds_and_follows");
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

/// busybox for the real-Docker tests: pulled only when missing (Docker Hub limits pulls).
pub(crate) fn ensure_busybox(d: &Docker) -> bool {
    let present = d.images().is_ok_and(|images| {
        images
            .iter()
            .any(|i| i.repository.as_deref() == Some("busybox") && i.tag.as_deref() == Some("1.36"))
    });
    if present {
        return true;
    }
    let pulled = Arc::new(Collector::default());
    if DockerJobs::default()
        .start(d, &pull_args("busybox:1.36").unwrap(), pulled.clone())
        .is_err()
    {
        return false;
    }
    matches!(
        pulled.wait(done).last(),
        Some(JobEvent::Done { ok: true, .. })
    )
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
    if !ensure_busybox(&d) {
        eprintln!("busybox could not be pulled, skipped");
        return;
    }
    let dir = project("real_docker_container_cy");
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

// ---- D3: terminals in containers ----

use super::terminal::{container_dir, terminal_args};
use super::ContainerMount;
use crate::profiles::{ContainerTarget, ProfileKind};

fn bind(source: &str, destination: &str) -> ContainerMount {
    ContainerMount {
        kind: "bind".into(),
        source: source.into(),
        destination: destination.into(),
        name: None,
        read_write: true,
    }
}

#[test]
fn a_container_terminal_is_docker_exec_with_a_shell_fallback() {
    let target = ContainerTarget {
        name: "sklep-agenci".into(),
        auto_start: true,
        ..Default::default()
    };
    let args = terminal_args(&target, None);
    assert_eq!(
        args[..10],
        [
            "exec",
            "-it",
            "-w",
            "/workspace",
            "-e",
            "TERM=xterm-256color",
            "-e",
            "COLORTERM=truecolor",
            "--",
            "sklep-agenci"
        ]
    );
    assert_eq!(args[10..12], ["sh", "-c"]);
    assert_eq!(
        args[12],
        r#"s='/bin/bash'; [ -x "$s" ] || s=$(command -v bash || command -v sh); exec "$s" -l"#
    );

    let custom = ContainerTarget {
        name: "c".into(),
        user: Some("agent".into()),
        shell: Some("/usr/bin/zsh".into()),
        workdir: Some("/srv/app".into()),
        auto_start: false,
        host: None,
    };
    let args = terminal_args(&custom, None);
    assert_eq!(args[3], "/srv/app");
    assert_eq!(args[8..10], ["-u", "agent"]);
    assert!(args.last().unwrap().starts_with("s='/usr/bin/zsh';"));
    // The project folder in the container wins over the profile's directory.
    assert_eq!(
        terminal_args(&custom, Some("/workspace/src"))[3],
        "/workspace/src"
    );
}

#[test]
fn a_project_folder_is_found_in_the_containers_mounts() {
    let mounts = [
        bind("/home/me/sklep", "/workspace"),
        bind("/home/me/sklep/vendor", "/opt/vendor"),
        ContainerMount {
            kind: "volume".into(),
            ..bind("/var/lib/docker/volumes/x/_data", "/root")
        },
    ];
    let dir = |p: &str| container_dir(&mounts, std::path::Path::new(p));
    assert_eq!(dir("/home/me/sklep").as_deref(), Some("/workspace"));
    assert_eq!(
        dir("/home/me/sklep/src/app/").as_deref(),
        Some("/workspace/src/app")
    );
    assert_eq!(
        dir("/home/me/sklep/vendor/lib").as_deref(),
        Some("/opt/vendor/lib"),
        "the deepest mount"
    );
    assert_eq!(
        dir("/home/me/sklep/a/../b").as_deref(),
        Some("/workspace/b")
    );
    assert_eq!(dir("/home/me/inny"), None, "not mounted");
    assert_eq!(dir("/home/me/sklepik"), None, "a prefix is not a folder");
    assert_eq!(
        dir("/var/lib/docker/volumes/x/_data"),
        None,
        "volumes are not this machine's folders"
    );
    assert_eq!(
        container_dir(&[bind("/", "/host")], std::path::Path::new("/etc")).as_deref(),
        Some("/host/etc")
    );
}

#[test]
fn a_container_is_prepared_and_started_when_allowed() {
    let log = std::env::temp_dir().join(format!("lf-fake-docker-d3-{}.log", std::process::id()));
    let d = fake("ok");
    let target = |name: &str| ContainerTarget {
        name: name.into(),
        auto_start: true,
        ..Default::default()
    };
    let calls = logged(&d, &log, |d| {
        let p = d
            .prepare(
                &target("sklep-agenci"),
                Some(std::path::Path::new("/home/me/sklep/src")),
                false,
            )
            .unwrap();
        assert!(p.running && !p.started);
        assert_eq!(p.workdir, "/workspace/src");
        // Stopped: reported, not started, unless allowed.
        let p = d.prepare(&target("baza"), None, false).unwrap();
        assert!(!p.running && !p.started);
        assert_eq!(p.workdir, "/workspace");
        let p = d
            .prepare(
                &target("baza"),
                Some(std::path::Path::new("/home/me/sklep")),
                true,
            )
            .unwrap();
        assert!(p.running && p.started);
        assert_eq!(
            p.workdir, "/workspace",
            "not mounted in this container: the profile's directory"
        );
    });
    let starts: Vec<&String> = calls.iter().filter(|c| c.starts_with("start|")).collect();
    assert_eq!(starts, ["start|--|baza"]);
    assert!(matches!(
        d.prepare(&target("nie-ma"), None, true),
        Err(DockerError::NoSuchObject(_))
    ));
}

#[test]
fn containers_made_for_leverframe_become_profiles() {
    let profiles = fake("ok").detect_profiles();
    assert_eq!(profiles.len(), 1, "only labelled containers");
    let p = &profiles[0];
    assert_eq!(
        (p.id.as_str(), p.name.as_str(), p.kind),
        (
            "container:sklep-agenci",
            "sklep-agenci",
            ProfileKind::Container
        )
    );
    assert_eq!(p.description.as_deref(), Some("leverframe-agents:0.8.0"));
    assert!(p.container.as_ref().unwrap().auto_start);
    assert!(fake("down").detect_profiles().is_empty());
    assert!(Docker::new("leverframe-no-such-docker-program")
        .detect_profiles()
        .is_empty());
}

/// A terminal in a real container: `pwd` is the project folder, a file made in the container is
/// on this machine (busybox has no bash: the shell falls back to sh). Skipped without Docker.
#[cfg(unix)]
#[test]
fn real_docker_terminal_when_available() {
    use crate::pty::{PtyEvents, PtyManager, SpawnOptions};
    let d = Docker::new("docker");
    let info = d.info();
    if !info.running || info.server_os.as_deref() != Some("linux") {
        eprintln!("Docker with Linux containers not available, skipped");
        return;
    }
    if !ensure_busybox(&d) {
        eprintln!("busybox could not be pulled, skipped");
        return;
    }
    let dir = project("real_docker_terminal_whe").join(format!("term-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    let name = format!("lf-term-{}", std::process::id());
    let _ = d.remove(&name, true);
    d.create(&ContainerSpec {
        image: "busybox:1.36".into(),
        name: name.clone(),
        project_dir: Some(dir.to_string_lossy().into_owned()),
        ..Default::default()
    })
    .unwrap();
    d.stop(&name).unwrap();

    #[derive(Default)]
    struct Out(Mutex<Vec<u8>>, Mutex<Option<Option<u32>>>);
    impl PtyEvents for Out {
        fn data(&self, bytes: Vec<u8>) {
            self.0.lock().unwrap().extend(bytes);
        }
        fn exit(&self, code: Option<u32>) {
            *self.1.lock().unwrap() = Some(code);
        }
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let target = ContainerTarget {
            name: name.clone(),
            auto_start: true,
            ..Default::default()
        };
        let prepared = d.prepare(&target, Some(&dir.join("src")), true).unwrap();
        assert!(prepared.started);
        assert_eq!(prepared.workdir, "/workspace/src");
        let out = Arc::new(Out::default());
        let ptys = PtyManager::new();
        let pty = ptys
            .spawn(
                SpawnOptions {
                    program: Some("docker".into()),
                    args: terminal_args(&target, Some(&prepared.workdir)),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                out.clone(),
            )
            .unwrap();
        ptys.write(
            pty.id,
            b"echo LF-$(pwd); echo z-kontenera > ../z.txt; exit 3\n",
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while out.1.lock().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the terminal did not end"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let text = String::from_utf8_lossy(&out.0.lock().unwrap()).into_owned();
        assert!(text.contains("LF-/workspace/src"), "{text}");
        assert_eq!(*out.1.lock().unwrap(), Some(Some(3)));
        assert_eq!(
            std::fs::read_to_string(dir.join("z.txt")).unwrap().trim(),
            "z-kontenera"
        );
    }));
    let _ = d.remove(&name, true);
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

// ---- D4: agents in containers ----

#[cfg(unix)]
mod agents_in_containers {
    use super::*;
    use crate::agents::{detect, AgentDef};
    use crate::profiles::{Profile, ProfileSource};
    use crate::sessions::logs::SshLogs;

    const CLAUDE_LOG: &str = include_str!("../sessions/logs/fixtures/claude.jsonl");
    /// The fake container's home is in an environment variable of this process: one test at a time.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn container_profile(program: &str, container: &str) -> Profile {
        Profile {
            id: format!("container:{container}"),
            name: container.into(),
            kind: ProfileKind::Container,
            command: program.into(),
            args: vec![],
            env: Default::default(),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            container: Some(ContainerTarget {
                name: container.into(),
                auto_start: true,
                ..Default::default()
            }),
            source: ProfileSource::Detected,
        }
    }

    /// The built-in agents and one that surely is not on this machine (by its name).
    fn catalog() -> Vec<AgentDef> {
        let test_agent = r#"{ "agents": [{ "id": "lftest", "name": "Agent testowy", "commands": ["lf-test-agent"] }] }"#;
        crate::agents::load_catalog(crate::agents::BUILTIN_AGENTS_JSON, Some(test_agent)).agents
    }

    /// The "container" of the fake docker: its home with an agent and a Claude log.
    fn container_home(test: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let home =
            std::env::temp_dir().join(format!("lf-fake-container-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("bin")).unwrap();
        let agent = home.join("bin/lf-test-agent");
        std::fs::write(&agent, "#!/bin/sh\necho '9.9.9 (agent w kontenerze)'\n").unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let logs = home.join(".claude/projects/-workspace");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("5f1c2a9e-1111-4c3b-9d7e-0123456789ab.jsonl"),
            CLAUDE_LOG,
        )
        .unwrap();
        home
    }

    fn program() -> String {
        crate::test_support::example("fake_docker")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn agents_are_detected_in_a_container() {
        let _lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = container_home("detect");
        std::env::set_var("FAKE_DOCKER_HOME", &home);
        let profile = container_profile(&program(), "sklep-agenci");
        let found = detect(&profile, &catalog(), Duration::from_secs(30)).unwrap();
        let agent = found.iter().find(|a| a.id == "lftest").unwrap();
        assert!(agent.installed, "{found:?}");
        assert_eq!(agent.version.as_deref(), Some("9.9.9 (agent w kontenerze)"));

        let stopped = container_profile(&program(), "baza");
        let err = detect(&stopped, &catalog(), Duration::from_secs(30)).unwrap_err();
        assert!(err.contains("Brak odpowiedzi z kontenera"), "{err}");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn agent_logs_are_listed_and_read_in_a_container() {
        let _lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = container_home("logs");
        std::env::set_var("FAKE_DOCKER_HOME", &home);
        let logs = SshLogs::default();
        let profile = container_profile(&program(), "sklep-agenci");
        let source = "docker:container:sklep-agenci";
        let list = logs.list(&profile, source).unwrap();
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(list[0].source, source);
        let path = list[0].path.clone();
        assert!(path
            .ends_with("/.claude/projects/-workspace/5f1c2a9e-1111-4c3b-9d7e-0123456789ab.jsonl"));
        let detail = logs.read(&profile, source, &path).unwrap();
        assert!(!detail.entries.is_empty());

        let err = logs
            .list(
                &container_profile(&program(), "baza"),
                "docker:container:baza",
            )
            .unwrap_err();
        assert!(err.contains("Kontener musi działać"), "{err}");
        assert!(
            logs.read(&profile, source, "/root/.claude/inny.jsonl")
                .is_err(),
            "only listed logs"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    /// An agent and its log in a real container: detected and listed. Skipped without Docker.
    #[test]
    fn real_docker_agents_when_available() {
        let d = Docker::new("docker");
        let info = d.info();
        if !info.running || info.server_os.as_deref() != Some("linux") || !ensure_busybox(&d) {
            eprintln!("Docker with Linux containers not available, skipped");
            return;
        }
        let name = format!("lf-agents-{}", std::process::id());
        let _ = d.remove(&name, true);
        d.create(&ContainerSpec {
            image: "busybox:1.36".into(),
            name: name.clone(),
            ..Default::default()
        })
        .unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let sh = |script: &str| {
                let ok = std::process::Command::new("docker")
                    .args(["exec", &name, "sh", "-c", script])
                    .status()
                    .unwrap()
                    .success();
                assert!(ok, "{script}");
            };
            sh("mkdir -p /usr/local/bin /root/.claude/projects/-workspace && printf '#!/bin/sh\\necho 1.2.3-claude\\n' > /usr/local/bin/claude && chmod +x /usr/local/bin/claude");
            let log = std::env::temp_dir().join(format!("lf-agents-{}.jsonl", std::process::id()));
            std::fs::write(&log, CLAUDE_LOG).unwrap();
            let ok = std::process::Command::new("docker")
                .args([
                    "cp",
                    &log.to_string_lossy(),
                    &format!("{name}:/root/.claude/projects/-workspace/5f1c.jsonl"),
                ])
                .status()
                .unwrap()
                .success();
            assert!(ok);
            let _ = std::fs::remove_file(&log);

            let profile = container_profile("docker", &name);
            let found = detect(&profile, &catalog(), Duration::from_secs(30)).unwrap();
            let claude = found.iter().find(|a| a.id == "claude").unwrap();
            assert!(claude.installed, "{found:?}");
            assert_eq!(claude.version.as_deref(), Some("1.2.3-claude"));

            let logs = SshLogs::default();
            let source = format!("docker:container:{name}");
            let list = logs.list(&profile, &source).unwrap();
            assert_eq!(list.len(), 1, "{list:?}");
            assert_eq!(list[0].path, "/root/.claude/projects/-workspace/5f1c.jsonl");
            assert!(!logs
                .read(&profile, &source, &list[0].path)
                .unwrap()
                .entries
                .is_empty());

            d.stop(&name).unwrap();
            assert!(
                logs.list(&profile, &source).is_err(),
                "a stopped container is reported"
            );
        }));
        let _ = d.remove(&name, true);
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }
}

/// A fake `ssh` (runs the remote command with `sh -c`) and a folder with `docker` for it.
#[cfg(unix)]
fn fake_ssh(name: &str, docker: &str) -> (std::path::PathBuf, Vec<String>) {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("lf-fake-ssh-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let ssh = dir.join("ssh");
    std::fs::write(
        &ssh,
        "#!/bin/sh\n[ -n \"$FAKE_SSH_FAIL\" ] && { echo 'ssh: connect to host srv port 22: Connection refused' >&2; exit 255; }\nfor a; do last=$a; done\nexec /bin/sh -c \"$last\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("docker"), docker).unwrap();
    for f in ["ssh", "docker"] {
        std::fs::set_permissions(dir.join(f), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let cmd = vec![
        ssh.to_string_lossy().into_owned(),
        "-o".into(),
        "BatchMode=yes".into(),
        "me@srv".into(),
    ];
    (dir, cmd)
}

#[cfg(unix)]
#[test]
fn docker_through_ssh_runs_on_the_host_with_quoted_arguments() {
    let (dir, ssh) = fake_ssh("quote", "#!/bin/sh\nprintf '[%s]\\n' \"$@\"\n");
    let path = format!(
        "{}:{}",
        dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    // No local docker: the program from the settings is not used.
    let d = Docker::new("/nonexistent/docker")
        .with_env("PATH", &path)
        .via_ssh(ssh);
    let out = d
        .ok(
            &[
                "exec",
                "-i",
                "--",
                "c1",
                "sh",
                "-c",
                "echo 'a b' \"$HOME\"; ls *",
            ],
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(
        out,
        "[exec]\n[-i]\n[--]\n[c1]\n[sh]\n[-c]\n[echo 'a b' \"$HOME\"; ls *]\n"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn docker_through_ssh_reports_ssh_and_missing_docker() {
    let (dir, ssh) = fake_ssh("errors", "#!/bin/sh\necho 'permission denied while trying to connect to the Docker daemon socket' >&2\nexit 1\n");
    let path = format!(
        "{}:{}",
        dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let d = Docker::new("docker")
        .with_env("PATH", &path)
        .via_ssh(ssh.clone());
    assert!(matches!(
        d.ok(&["ps"], Duration::from_secs(10)),
        Err(DockerError::PermissionDenied)
    ));
    let info = d.info();
    assert!(!info.running);

    let failing = d.clone().with_env("FAKE_SSH_FAIL", "1");
    let err = failing.ok(&["ps"], Duration::from_secs(10)).unwrap_err();
    assert!(matches!(err, DockerError::Ssh(_)), "{err:?}");
    assert!(err.to_string().contains("Connection refused"), "{err}");

    // A host without docker: the shell answers 127.
    let no_docker = Docker::new("docker")
        .with_env("PATH", "/leverframe-nonexistent")
        .via_ssh(ssh);
    let err = no_docker.ok(&["ps"], Duration::from_secs(10)).unwrap_err();
    assert!(err.to_string().contains("nie ma programu docker"), "{err}");

    let missing = Docker::new("docker").via_ssh(vec!["/nonexistent/ssh".into(), "srv".into()]);
    let err = missing.ok(&["ps"], Duration::from_secs(10)).unwrap_err();
    assert!(err.to_string().contains("OpenSSH"), "{err}");
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn a_job_through_ssh_gets_its_input() {
    use std::sync::{Arc, Mutex};
    struct Collect(Mutex<Vec<super::JobEvent>>, std::sync::mpsc::Sender<()>);
    impl super::JobEvents for Collect {
        fn emit(&self, event: super::JobEvent) {
            let done = matches!(event, super::JobEvent::Done { .. });
            self.0.lock().unwrap().push(event);
            if done {
                let _ = self.1.send(());
            }
        }
    }
    // `docker build … -` reads the Dockerfile from stdin.
    let (dir, ssh) = fake_ssh("input", "#!/bin/sh\necho \"args: $*\"\nwc -l | tr -d ' '\n");
    let path = format!(
        "{}:{}",
        dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let d = Docker::new("docker").with_env("PATH", &path).via_ssh(ssh);
    let (tx, rx) = std::sync::mpsc::channel();
    let events = Arc::new(Collect(Mutex::new(Vec::new()), tx));
    let jobs = super::DockerJobs::default();
    jobs.start_with_input(
        &d,
        &super::image::agents_build_args(),
        Some(super::image::AGENTS_DOCKERFILE.as_bytes().to_vec()),
        events.clone(),
    )
    .unwrap();
    rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let lines: Vec<String> = events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            super::JobEvent::Line { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        lines[0],
        format!(
            "args: build --progress=plain -t {} -",
            super::image::agents_image_tag()
        )
    );
    assert_eq!(
        lines[1],
        super::image::AGENTS_DOCKERFILE.lines().count().to_string()
    );
    let _ = std::fs::remove_dir_all(dir);
}
