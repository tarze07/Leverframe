//! `PATH` of the app on Windows. Leverframe gets the `PATH` its parent had at login: folders added
//! later to the user's or the system's `PATH` (an installer, a company policy) are missing, so the
//! agents there are not found and do not start in its terminals. At start the `PATH` is completed
//! from the registry and with the usual install folders of the agents (`.claude\bin`, …) that
//! exist. Child processes (detection, terminals, conversation mode) inherit it.

/// Folders where agents install themselves, relative to the home folder (when they exist).
pub const AGENT_DIRS: &[&str] = &[
    ".claude\\bin",
    ".claude\\local",
    ".local\\bin",
    ".opencode\\bin",
    "AppData\\Roaming\\npm",
];

/// `%NAME%` replaced with the variable's value (unknown names stay as they are).
pub fn expand(text: &str, var: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match var(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The current `PATH` first, then the missing folders of the system's and the user's `PATH`
/// (from the registry), then the agents' folders that exist. Folders are compared without case
/// and trailing backslashes; empty entries are dropped.
pub fn completed_path(current: &str, machine: &str, user: &str, agent_dirs: &[String]) -> String {
    let key = |d: &str| d.trim().trim_end_matches('\\').to_lowercase();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for dir in current
        .split(';')
        .chain(machine.split(';'))
        .chain(user.split(';'))
        .map(str::to_string)
        .chain(agent_dirs.iter().cloned())
    {
        let dir = dir.trim().to_string();
        if dir.is_empty() || !seen.insert(key(&dir)) {
            continue;
        }
        out.push(dir);
    }
    out.join(";")
}

/// Completes this process's `PATH` (Windows; call before any thread or child process starts).
#[cfg(windows)]
pub fn complete_windows_path() {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let read = |root, key: &str| {
        RegKey::predef(root)
            .open_subkey(key)
            .and_then(|k| k.get_value::<String, _>("Path"))
            .unwrap_or_default()
    };
    let var = |name: &str| std::env::var(name).ok();
    let machine = expand(
        &read(
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        var,
    );
    let user = expand(&read(HKEY_CURRENT_USER, "Environment"), var);
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let agents: Vec<String> = AGENT_DIRS
        .iter()
        .map(|d| std::path::Path::new(&home).join(d))
        .filter(|p| !home.is_empty() && p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let current = std::env::var("PATH").unwrap_or_default();
    let path = completed_path(&current, &machine, &user, &agents);
    if path != current {
        std::env::set_var("PATH", path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_variables_of_registry_paths() {
        let var = |n: &str| match n {
            "USERPROFILE" => Some(r"C:\Users\Jan".to_string()),
            "SystemRoot" => Some(r"C:\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand(r"%USERPROFILE%\.claude\bin", var),
            r"C:\Users\Jan\.claude\bin"
        );
        assert_eq!(
            expand(r"%SystemRoot%\system32;%NIEMA%\x;100%", var),
            r"C:\Windows\system32;%NIEMA%\x;100%"
        );
        assert_eq!(expand("bez zmiennych", var), "bez zmiennych");
    }

    #[test]
    fn adds_missing_folders_once_after_the_current_ones() {
        let path = completed_path(
            r"C:\Windows\system32;C:\Program Files\Git\cmd;",
            r"C:\WINDOWS\System32\;C:\Program Files\Docker\Docker\resources\bin",
            r"C:\Users\Jan\.claude\bin;;C:\Users\Jan\AppData\Roaming\npm",
            &[
                r"C:\Users\Jan\.claude\bin".into(),
                r"C:\Users\Jan\.local\bin".into(),
            ],
        );
        assert_eq!(
            path.split(';').collect::<Vec<_>>(),
            [
                r"C:\Windows\system32",
                r"C:\Program Files\Git\cmd",
                r"C:\Program Files\Docker\Docker\resources\bin",
                r"C:\Users\Jan\.claude\bin",
                r"C:\Users\Jan\AppData\Roaming\npm",
                r"C:\Users\Jan\.local\bin",
            ]
        );
        // Nothing new: unchanged.
        assert_eq!(completed_path("A;B", "a", "b\\", &[]), "A;B");
    }
}
