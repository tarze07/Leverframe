//! Docker on another machine through SSH (D8, #79): the docker CLI of this machine talks to the
//! daemon on an SSH host itself (`DOCKER_HOST=ssh://[user@]host[:port]` – it runs
//! `docker system dial-stdio` there). Leverframe keeps calling the local CLI, with the variable.

use crate::profiles::{Profile, ProfileKind, SshTarget};

/// Setting: id of the SSH profile whose Docker the "Kontenery" view shows (`null`: this machine).
pub const DOCKER_SOURCE_KEY: &str = "dockerSource";

/// The CLI variable naming the daemon.
pub const DOCKER_HOST: &str = "DOCKER_HOST";

/// Setting: how the Docker of an SSH host is reached – `auto` (the local docker CLI when there
/// is one, else ssh), `client` (local CLI with `DOCKER_HOST`) or `ssh` (`docker` run on the host
/// through `ssh`, no local CLI needed).
pub const DOCKER_SSH_MODE_KEY: &str = "dockerSshMode";

/// In a container profile's environment: the `ssh` command (JSON list) that runs its `docker`
/// on the SSH host (mode `ssh`). Leverframe's own marker, not passed on by the CLI.
pub const DOCKER_SSH: &str = "LEVERFRAME_DOCKER_SSH";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// The local docker CLI with `DOCKER_HOST=ssh://…`.
    Client,
    /// `ssh <host> docker …`.
    Ssh,
}

/// The transport for a mode setting; `auto` uses the local CLI when it is installed.
pub fn transport(mode: Option<&str>, local_client: bool) -> Transport {
    match mode {
        Some("client") => Transport::Client,
        Some("ssh") => Transport::Ssh,
        _ if local_client => Transport::Client,
        _ => Transport::Ssh,
    }
}

/// Whether the docker CLI `program` (a path or a name in `PATH`) exists on this machine.
pub fn local_client_available(program: &str) -> bool {
    let program = if program.trim().is_empty() {
        "docker"
    } else {
        program.trim()
    };
    let path = std::path::Path::new(program);
    if program.contains(['/', '\\']) {
        return path.is_file();
    }
    let exts: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .any(|dir| {
            exts.iter()
                .any(|e| dir.join(format!("{program}{e}")).is_file())
        })
}

/// The `ssh` command reaching an SSH profile's host, without questions (BatchMode); the key of
/// the profile is used (`-i`), unlike with `DOCKER_HOST`.
pub fn ssh_command(profile: &Profile) -> Result<Vec<String>, String> {
    let target = profile
        .ssh
        .as_ref()
        .ok_or_else(|| format!("{} nie ma danych połączenia SSH", profile.name))?;
    target.validate()?;
    let mut cmd = vec![profile.launch_spec().program];
    cmd.extend(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"].map(String::from));
    cmd.extend(target.args());
    Ok(cmd)
}

fn sh_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@,+%".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// `docker <args>` as one command line for the host's shell (every word quoted when needed).
pub fn remote_docker(args: &[String]) -> String {
    std::iter::once("docker".to_string())
        .chain(args.iter().map(|a| sh_quote(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Program and arguments running `docker <args>` on the host through `ssh` (`tty`: with a
/// terminal, for interactive shells).
pub fn over_ssh(ssh: &[String], tty: bool, docker_args: &[String]) -> (String, Vec<String>) {
    let mut args: Vec<String> = ssh[1..].to_vec();
    // The destination is last in `ssh_command`; options must come before it.
    let destination = args.pop().unwrap_or_default();
    args.push(if tty { "-tt" } else { "-T" }.into());
    args.push(destination);
    args.push(remote_docker(docker_args));
    (ssh[0].clone(), args)
}

/// The `ssh` command of a container profile in mode `ssh`.
pub fn ssh_of(env: &std::collections::BTreeMap<String, String>) -> Option<Vec<String>> {
    env.get(DOCKER_SSH)
        .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
        .filter(|v| v.len() >= 2)
}

/// Program and arguments for `docker <args>` of a container profile: the profile's docker
/// `program`, or `ssh … docker …` in mode `ssh` (see [`DOCKER_SSH`]).
pub fn invocation(
    program: &str,
    env: &std::collections::BTreeMap<String, String>,
    tty: bool,
    docker_args: Vec<String>,
) -> (String, Vec<String>) {
    match ssh_of(env) {
        Some(ssh) => over_ssh(&ssh, tty, &docker_args),
        None => (program.to_string(), docker_args),
    }
}

/// Environment for a container profile's command: without Leverframe's marker.
pub fn command_env(env: &std::collections::BTreeMap<String, String>) -> Vec<(String, String)> {
    env.iter()
        .filter(|(k, _)| *k != DOCKER_SSH)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// How the Docker of an SSH host is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The local CLI with this `DOCKER_HOST`.
    Client(String),
    /// This `ssh` command running `docker` on the host.
    Ssh(Vec<String>),
}

impl Route {
    /// The CLI for this route.
    pub fn docker(&self, d: super::Docker) -> super::Docker {
        match self {
            Self::Client(url) => d.with_env(DOCKER_HOST, url),
            Self::Ssh(ssh) => d.via_ssh(ssh.clone()),
        }
    }

    /// The variable a container profile on that host gets.
    pub fn env(&self) -> (String, String) {
        match self {
            Self::Client(url) => (DOCKER_HOST.into(), url.clone()),
            Self::Ssh(ssh) => (
                DOCKER_SSH.into(),
                serde_json::to_string(ssh).unwrap_or_default(),
            ),
        }
    }
}

/// The SSH profile `id` and how its Docker is reached.
pub fn route<'a>(
    profiles: &'a [Profile],
    id: &str,
    transport: Transport,
) -> Result<(&'a Profile, Route), String> {
    match transport {
        Transport::Client => source(profiles, id).map(|(p, url)| (p, Route::Client(url))),
        Transport::Ssh => {
            let profile = profiles
                .iter()
                .find(|p| p.id == id && p.kind == ProfileKind::Ssh)
                .ok_or_else(|| {
                    format!("Profil SSH „{id}” nie istnieje – wybierz inne źródło Dockera")
                })?;
            Ok((profile, Route::Ssh(ssh_command(profile)?)))
        }
    }
}

/// `ssh://[user@]host[:port]` for an SSH target. Only plain names: the URL goes to the CLI.
pub fn docker_host_url(target: &SshTarget) -> Result<String, String> {
    let host = target.host.trim();
    let plain = |s: &str, extra: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c) || extra.contains(c))
    };
    let host = if host.contains(':') {
        // IPv6 in brackets.
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        if !plain(bare, ":") {
            return Err(format!("Nieprawidłowy adres hosta: {host}"));
        }
        format!("[{bare}]")
    } else if plain(host, "") {
        host.to_string()
    } else {
        return Err(format!("Nieprawidłowy adres hosta: {host}"));
    };
    let mut url = String::from("ssh://");
    if let Some(user) = target
        .user
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        if !plain(user, "") {
            return Err(format!("Nieprawidłowy użytkownik SSH: {user}"));
        }
        url.push_str(user);
        url.push('@');
    }
    url.push_str(&host);
    if let Some(port) = target.port.filter(|p| *p != 22) {
        url.push_str(&format!(":{port}"));
    }
    Ok(url)
}

/// The SSH profile `id` among `profiles` and its `DOCKER_HOST`.
pub fn source<'a>(profiles: &'a [Profile], id: &str) -> Result<(&'a Profile, String), String> {
    let profile = profiles
        .iter()
        .find(|p| p.id == id && p.kind == ProfileKind::Ssh)
        .ok_or_else(|| format!("Profil SSH „{id}” nie istnieje – wybierz inne źródło Dockera"))?;
    let target = profile
        .ssh
        .as_ref()
        .ok_or_else(|| format!("{} nie ma danych połączenia SSH", profile.name))?;
    Ok((profile, docker_host_url(target)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_chooses_the_transport() {
        assert_eq!(transport(Some("auto"), true), Transport::Client);
        assert_eq!(transport(Some("auto"), false), Transport::Ssh);
        assert_eq!(transport(None, false), Transport::Ssh);
        assert_eq!(transport(Some("client"), false), Transport::Client);
        assert_eq!(transport(Some("ssh"), true), Transport::Ssh);
        assert!(!local_client_available("/nonexistent/docker"));
        assert!(!local_client_available("leverframe-no-such-docker-42"));
        #[cfg(unix)]
        assert!(local_client_available("sh") && local_client_available("/bin/sh"));
    }

    fn ssh_profile(t: SshTarget) -> Profile {
        Profile {
            id: "user-srv".into(),
            name: "srv".into(),
            kind: ProfileKind::Ssh,
            command: String::new(),
            args: Vec::new(),
            env: Default::default(),
            cwd: None,
            icon: None,
            description: None,
            ssh: Some(t),
            container: None,
            source: Default::default(),
        }
    }

    #[test]
    fn docker_commands_through_ssh() {
        let mut t = target("srv", Some("me"), Some(2222));
        t.identity_file = Some("/home/me/.ssh/id key".into());
        let ssh = ssh_command(&ssh_profile(t)).unwrap();
        assert_eq!(
            ssh,
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=15",
                "-p",
                "2222",
                "-i",
                "/home/me/.ssh/id key",
                "me@srv"
            ]
        );
        let words = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (program, args) = over_ssh(&ssh, true, &words(&["exec", "-it", "c1", "bash", "-l"]));
        assert_eq!(program, "ssh");
        assert_eq!(
            &args[args.len() - 3..],
            ["-tt", "me@srv", "docker exec -it c1 bash -l"]
        );
        let (_, args) = over_ssh(
            &ssh,
            false,
            &words(&["exec", "-i", "c1", "sh", "-c", "cd ~ && it's"]),
        );
        assert_eq!(
            &args[args.len() - 3..],
            ["-T", "me@srv", r"docker exec -i c1 sh -c 'cd ~ && it'\''s'"]
        );
        assert_eq!(remote_docker(&words(&["ps", ""])), "docker ps ''");
        assert!(ssh_command(&ssh_profile(target("-oProxyCommand=x", None, None))).is_err());

        // A container profile keeps the ssh command in its environment.
        let route = Route::Ssh(ssh.clone());
        let (key, value) = route.env();
        let env =
            std::collections::BTreeMap::from([(key, value), ("A".to_string(), "1".to_string())]);
        assert_eq!(ssh_of(&env), Some(ssh));
        assert_eq!(command_env(&env), [("A".to_string(), "1".to_string())]);
        let (program, args) = invocation("docker", &env, false, words(&["ps"]));
        assert_eq!(
            (program.as_str(), args.last().unwrap().as_str()),
            ("ssh", "docker ps")
        );
        let (program, args) = invocation("docker", &Default::default(), false, words(&["ps"]));
        assert_eq!((program.as_str(), args), ("docker", words(&["ps"])));
    }

    #[test]
    fn routes_of_ssh_profiles() {
        let profiles = vec![ssh_profile(target("srv", Some("me"), None))];
        let (_, r) = route(&profiles, "user-srv", Transport::Client).unwrap();
        assert_eq!(r, Route::Client("ssh://me@srv".into()));
        let (_, r) = route(&profiles, "user-srv", Transport::Ssh).unwrap();
        assert!(matches!(r, Route::Ssh(ref c) if c.last().unwrap() == "me@srv"));
        assert!(route(&profiles, "user-gone", Transport::Ssh).is_err());
    }

    fn target(host: &str, user: Option<&str>, port: Option<u16>) -> SshTarget {
        SshTarget {
            host: host.into(),
            port,
            user: user.map(String::from),
            identity_file: None,
        }
    }

    #[test]
    fn docker_host_urls_from_ssh_profiles() {
        let url = |t| docker_host_url(&t).unwrap();
        assert_eq!(url(target("srv", None, None)), "ssh://srv");
        assert_eq!(
            url(target("srv.example.com", Some("me"), Some(2222))),
            "ssh://me@srv.example.com:2222"
        );
        assert_eq!(url(target("gpu-1", Some("me"), Some(22))), "ssh://me@gpu-1");
        assert_eq!(
            url(target("fe80::1", None, Some(2200))),
            "ssh://[fe80::1]:2200"
        );
        assert_eq!(url(target("[::1]", Some("root"), None)), "ssh://root@[::1]");
        for bad in [
            target("srv;rm", None, None),
            target("-oProxyCommand=x", None, None),
            target("srv", Some("me@x"), None),
            target("", None, None),
            target("a b", None, None),
        ] {
            assert!(docker_host_url(&bad).is_err(), "{bad:?}");
        }
    }
}
