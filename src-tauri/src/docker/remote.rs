//! Docker on another machine through SSH (D8, #79): the docker CLI of this machine talks to the
//! daemon on an SSH host itself (`DOCKER_HOST=ssh://[user@]host[:port]` – it runs
//! `docker system dial-stdio` there). Leverframe keeps calling the local CLI, with the variable.

use crate::profiles::{Profile, ProfileKind, SshTarget};

/// Setting: id of the SSH profile whose Docker the "Kontenery" view shows (`null`: this machine).
pub const DOCKER_SOURCE_KEY: &str = "dockerSource";

/// The CLI variable naming the daemon.
pub const DOCKER_HOST: &str = "DOCKER_HOST";

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
