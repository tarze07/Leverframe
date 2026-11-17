#!/bin/sh
# Checks an image with agents: run inside a container of it, e.g.
#   docker run --rm -i leverframe-agents:<wersja> sh -s < packaging/docker/agents/check.sh
# The agents answer --version; the conversation-mode adapters answer ACP `initialize`.
set -eu

fail() {
  echo "BŁĄD: $*" >&2
  exit 1
}

[ "$(id -un)" = agent ] || fail "użytkownik $(id -un) zamiast agent"
[ "$(id -u)" = 1000 ] || fail "UID $(id -u) zamiast 1000"
[ "$(pwd)" = /workspace ] || fail "katalog roboczy $(pwd) zamiast /workspace"
[ -w /workspace ] && [ -w "$HOME" ] || fail "brak zapisu w /workspace albo $HOME"
sudo -n true || fail "sudo bez hasła nie działa"
for tool in git rg ssh tini node npm; do
  command -v "$tool" >/dev/null || fail "brak $tool"
done

for agent in claude opencode; do
  version=$("$agent" --version 2>&1) || fail "$agent --version: $version"
  echo "$agent: $version"
done

initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}'
for adapter in claude-agent-acp "opencode acp"; do
  # stdin stays open a moment (the adapter answers before it ends).
  answer=$({ echo "$initialize"; sleep 20; } | timeout 30 $adapter 2>/dev/null | head -n 1) || true
  case "$answer" in
    *'"protocolVersion"'*) echo "$adapter: ACP $(echo "$answer" | grep -o '"protocolVersion":[0-9]*')" ;;
    *) fail "$adapter nie odpowiada na initialize: ${answer:-brak odpowiedzi}" ;;
  esac
done
echo "Obraz w porządku."
