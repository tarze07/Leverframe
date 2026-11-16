# Obraz z agentami CLI dla Leverframe (kontenery Docker, docs/DOCKER.md § 6).
#
# Budowanie: przycisk „Zbuduj obraz Leverframe” w widoku „Kontenery” albo
#   docker build -t leverframe-agents packaging/docker/agents
# Własny obraz projektu: FROM leverframe-agents:<wersja> + narzędzia projektu.
#
# Wersje są przypięte (co najmniej 2 tygodnie od wydania) i aktualizowane świadomie.

# Adapter trybu rozmowy Claude wymaga Node.js 22+.
FROM node:22.23.3-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.316
ARG CODEX_VERSION=0.166.0
ARG GEMINI_CLI_VERSION=0.66.0
ARG CLAUDE_AGENT_ACP_VERSION=0.99.1
ARG CODEX_ACP_VERSION=2.5.0

LABEL io.leverframe.agents="1" \
      org.opencontainers.image.title="leverframe-agents" \
      org.opencontainers.image.description="Agenci CLI (Claude Code, Codex, Gemini CLI) z adapterami trybu rozmowy (ACP) dla Leverframe" \
      org.opencontainers.image.source="https://github.com/tarze07/Leverframe"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git less openssh-client procps ripgrep sudo tini \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
 && npm cache clean --force

# Użytkownik bez roota: agent (UID 1000 – pliki w zamontowanym folderze mają w Linuksie
# właściciela jak na komputerze). Obraz node ma już użytkownika node z UID 1000 – zmiana nazwy.
# sudo bez hasła: agent może doinstalować narzędzia w kontenerze (zniknie razem z nim).
# Na Linuksie, gdy projekt należy do innego UID, kontener działa z `-u <UID>:<GID>` (ostrzeżenie
# w „Nowy kontener”): HOME zostaje /home/agent, a katalog domowy (i wolumen z niego) jest
# zapisywalny dla każdego użytkownika.
RUN groupmod -n agent node \
 && usermod -l agent -d /home/agent -m -s /bin/bash node \
 && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent \
 && chmod 0777 /home/agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

USER agent
ENV HOME=/home/agent \
    SHELL=/bin/bash \
    TINI_SUBREAPER=1
WORKDIR /workspace

# Leverframe tworzy kontener z `--init` i poleceniem `sleep infinity`; bez Leverframe tini
# zbiera procesy agentów.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
