//! The image with agents (D6, #68): the `Dockerfile` of `packaging/docker/agents`, shipped inside
//! the app, built as `leverframe-agents:<app version>` with the Dockerfile on standard input.

/// `packaging/docker/agents/Dockerfile` (it copies nothing from its folder).
pub const AGENTS_DOCKERFILE: &str = include_str!("../../../packaging/docker/agents/Dockerfile");

/// Name of the image with agents for this version of the app.
pub fn agents_image_tag() -> String {
    format!("leverframe-agents:{}", env!("CARGO_PKG_VERSION"))
}

/// `docker build` of the agents image with the Dockerfile on standard input (no context).
pub fn agents_build_args() -> Vec<String> {
    ["build", "--progress=plain", "-t", &agents_image_tag(), "-"]
        .map(String::from)
        .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_dockerfile_makes_an_image_for_leverframe() {
        let f = AGENTS_DOCKERFILE;
        assert!(f.contains("LABEL io.leverframe.agents=\"1\""));
        assert!(f.contains("WORKDIR /workspace"));
        assert!(f.contains("USER agent"));
        // Pinned versions only.
        let from = f.lines().find(|l| l.starts_with("FROM ")).unwrap();
        assert!(
            from.contains(":22.") && from.ends_with("-bookworm-slim"),
            "{from}"
        );
        for l in f.lines().filter(|l| l.starts_with("ARG ")) {
            let version = l.split('=').nth(1).unwrap_or_default();
            assert!(
                version.split('.').count() == 3
                    && version.chars().all(|c| c.is_ascii_digit() || c == '.'),
                "{l}"
            );
        }
        for pkg in [
            "@anthropic-ai/claude-code@",
            "@agentclientprotocol/claude-agent-acp@",
            "\"opencode-ai@",
        ] {
            assert!(f.contains(&format!("{pkg}${{")), "{pkg}");
        }
        // Only Claude Code and OpenCode (#85).
        for gone in ["@openai/codex", "@google/gemini-cli", "codex-acp"] {
            assert!(!f.contains(gone), "{gone}");
        }
        assert!(
            f.lines()
                .all(|l| !l.trim_start().starts_with("COPY") && !l.trim_start().starts_with("ADD")),
            "built from stdin: the context holds only the Dockerfile"
        );
        assert_eq!(
            agents_image_tag(),
            format!("leverframe-agents:{}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn the_agents_image_builds_from_standard_input() {
        let args = agents_build_args();
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(args.contains(&agents_image_tag()));
    }
}
