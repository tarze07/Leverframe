//! The command line typed into a terminal to start an agent: its program, the user's arguments
//! and environment variables, quoted for the shell of the profile.

use std::collections::BTreeMap;

use crate::profiles::{Profile, ProfileKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    /// sh, bash, zsh, fish – also every shell in WSL, on SSH hosts and in containers.
    Posix,
    PowerShell,
    Cmd,
}

/// The shell an agent is typed into for a profile (`None`: the default shell of this system).
pub fn shell_of(profile: Option<&Profile>) -> Shell {
    let Some(p) = profile else {
        return if cfg!(windows) {
            Shell::PowerShell
        } else {
            Shell::Posix
        };
    };
    match p.kind {
        ProfileKind::Powershell => Shell::PowerShell,
        ProfileKind::Local => {
            let program = p.command.to_ascii_lowercase();
            let name = program.rsplit(['/', '\\']).next().unwrap_or(&program);
            match name.trim_end_matches(".exe") {
                "cmd" => Shell::Cmd,
                "pwsh" | "powershell" => Shell::PowerShell,
                _ => Shell::Posix,
            }
        }
        _ => Shell::Posix,
    }
}

/// Words that need no quotes in any of the shells.
fn plain(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/=:+,@".contains(c))
}

fn quote(shell: Shell, word: &str) -> String {
    if plain(word) && !(shell == Shell::PowerShell && word.starts_with('@')) {
        return word.to_string();
    }
    match shell {
        Shell::Posix => format!("'{}'", word.replace('\'', r"'\''")),
        Shell::PowerShell => format!("'{}'", word.replace('\'', "''")),
        // Arguments never contain `"` or `%` (checked when the settings are loaded).
        Shell::Cmd => format!("\"{word}\""),
    }
}

/// `command` with the agent's arguments and environment, for `shell`.
pub fn typed_command(
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    shell: Shell,
) -> String {
    let mut line = String::new();
    for (name, value) in env {
        match shell {
            Shell::Posix => line.push_str(&format!("{name}={} ", quote(Shell::Posix, value))),
            // The variable stays in this terminal's session.
            Shell::PowerShell => {
                line.push_str(&format!("$env:{name}='{}'; ", value.replace('\'', "''")))
            }
            Shell::Cmd => line.push_str(&format!("set \"{name}={value}\" && ")),
        }
    }
    line.push_str(command);
    for a in args {
        line.push(' ');
        line.push_str(&quote(shell, a));
    }
    line
}

/// A first prompt as one argument for `shell`: control characters become spaces; for cmd and
/// PowerShell without `"` (Windows PowerShell drops it on the way to a program, cmd cannot quote
/// it), for cmd also without `%` – any shell takes it literally then.
pub fn prompt_word(prompt: &str, shell: Shell) -> String {
    let text: String = prompt
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .filter(|c| match shell {
            Shell::Posix => true,
            Shell::PowerShell => *c != '"',
            Shell::Cmd => !matches!(c, '"' | '%'),
        })
        .collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // A prompt is never taken for an option (`-…`).
    if text.starts_with('-') {
        format!(" {text}")
    } else {
        text
    }
}

/// The agent's arguments with a first prompt (`prompt_arg`: `""` – last argument, or a flag
/// before it).
pub fn args_with_prompt(
    args: &[String],
    prompt_arg: Option<&str>,
    prompt: &str,
    shell: Shell,
) -> Result<Vec<String>, String> {
    let flag = prompt_arg
        .ok_or("Ten agent nie przyjmuje polecenia przy starcie w terminalu – użyj trybu rozmowy")?;
    let mut out = args.to_vec();
    if !flag.is_empty() {
        out.push(flag.to_string());
    }
    let word = prompt_word(prompt, shell);
    if word.trim().is_empty() {
        return Err("Puste polecenie dla agenta".into());
    }
    out.push(word);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::ProfileSource;

    fn profile(kind: ProfileKind, command: &str) -> Profile {
        Profile {
            id: "p".into(),
            name: "p".into(),
            kind,
            command: command.into(),
            args: vec![],
            env: Default::default(),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            container: None,
            source: ProfileSource::Detected,
        }
    }

    #[test]
    fn the_shell_follows_the_profile() {
        assert_eq!(
            shell_of(Some(&profile(ProfileKind::Local, "/bin/zsh"))),
            Shell::Posix
        );
        assert_eq!(
            shell_of(Some(&profile(
                ProfileKind::Local,
                r"C:\Windows\System32\cmd.exe"
            ))),
            Shell::Cmd
        );
        assert_eq!(
            shell_of(Some(&profile(ProfileKind::Local, "pwsh.exe"))),
            Shell::PowerShell
        );
        assert_eq!(
            shell_of(Some(&profile(ProfileKind::Powershell, "powershell.exe"))),
            Shell::PowerShell
        );
        for kind in [ProfileKind::Wsl, ProfileKind::Ssh, ProfileKind::Container] {
            assert_eq!(shell_of(Some(&profile(kind, "x"))), Shell::Posix);
        }
    }

    #[test]
    fn arguments_and_variables_are_quoted_for_each_shell() {
        let args: Vec<String> = ["--model", "anthropic/claude-sonnet", "it's a test"]
            .map(String::from)
            .to_vec();
        let env: BTreeMap<String, String> =
            [("OPENCODE_CONFIG", "/home/me/oc.json"), ("A_B", "x y")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .into();
        assert_eq!(
            typed_command("opencode", &args, &env, Shell::Posix),
            "A_B='x y' OPENCODE_CONFIG=/home/me/oc.json opencode --model anthropic/claude-sonnet 'it'\\''s a test'"
        );
        assert_eq!(
            typed_command("opencode", &args, &env, Shell::PowerShell),
            "$env:A_B='x y'; $env:OPENCODE_CONFIG='/home/me/oc.json'; opencode --model anthropic/claude-sonnet 'it''s a test'"
        );
        assert_eq!(
            typed_command("opencode", &args, &env, Shell::Cmd),
            "set \"A_B=x y\" && set \"OPENCODE_CONFIG=/home/me/oc.json\" && opencode --model anthropic/claude-sonnet \"it's a test\""
        );
        assert_eq!(
            typed_command("claude", &[], &BTreeMap::new(), Shell::Posix),
            "claude"
        );
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[test]
    fn a_first_prompt_is_one_literal_word_in_each_shell() {
        let prompt =
            "Wykonaj zadanie z pliku .leverframe/tasks/1-a.md:\n„$HOME” `ls` \"100%\" it's";
        let args = args_with_prompt(
            &["--model".into(), "x".into()],
            Some(""),
            prompt,
            Shell::Posix,
        )
        .unwrap();
        assert_eq!(args.len(), 3);
        assert_eq!(
            typed_command("claude", &args, &Default::default(), Shell::Posix),
            "claude --model x 'Wykonaj zadanie z pliku .leverframe/tasks/1-a.md: „$HOME” `ls` \"100%\" it'\\''s'"
        );
        let ps = args_with_prompt(&[], Some("-i"), prompt, Shell::PowerShell).unwrap();
        assert_eq!(ps[0], "-i");
        assert_eq!(
            typed_command("gemini", &ps, &Default::default(), Shell::PowerShell),
            "gemini -i 'Wykonaj zadanie z pliku .leverframe/tasks/1-a.md: „$HOME” `ls` 100% it''s'"
        );
        let cmd = args_with_prompt(&[], Some("--prompt"), prompt, Shell::Cmd).unwrap();
        assert_eq!(
            cmd[1],
            "Wykonaj zadanie z pliku .leverframe/tasks/1-a.md: „$HOME” `ls` 100 it's"
        );
        assert_eq!(prompt_word("-rf /", Shell::Posix), " -rf /");
        assert!(args_with_prompt(&[], None, "x", Shell::Posix).is_err());
        assert!(args_with_prompt(&[], Some(""), " \n ", Shell::Posix).is_err());
    }
}
