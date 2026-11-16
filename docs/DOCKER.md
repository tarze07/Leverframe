# Leverframe – propozycja: kontenery Docker z agentami

Dokument odpowiada na zadanie [#60](https://github.com/tarze07/Leverframe/issues/60): jak łączyć się z kontenerem
z obrazu, w którym są zainstalowani agenci, jak takie kontenery uruchamiać i jak zarządzać obrazami Dockera
z Leverframe. Uzupełnia [PLAN.md](PLAN.md) i [ACP.md](ACP.md).

## 1. Cel

- **Agenci w izolacji**: agent (Claude Code, Codex, Gemini CLI, …) pracuje w kontenerze, a nie bezpośrednio na
  komputerze użytkownika. Widzi tylko zamontowany folder projektu, a jego polecenia (`npm install`, skrypty)
  nie zmieniają systemu.
- **Gotowe środowisko**: jeden obraz z agentami, adapterami trybu rozmowy (ACP), Node.js i narzędziami
  projektu. Ten sam obraz na każdym komputerze i u każdej osoby w zespole.
- **Wszystko z Leverframe**: terminal w kontenerze, agent w trybie terminalowym i w trybie rozmowy, historia
  sesji – tak samo jak dziś dla profili lokalnych, WSL i SSH.
- **Zarządzanie**: lista obrazów i kontenerów, pobranie i zbudowanie obrazu, utworzenie kontenera z folderem
  projektu, start / stop / restart / usunięcie, logi.

Poza zakresem pierwszej wersji (do decyzji później, § 9): Docker Compose, `devcontainer.json`, Kubernetes.

## 2. Założenia

- **Docker CLI, nie API.** Leverframe wywołuje polecenie `docker` (z `--format '{{json .}}'`), tak jak dziś
  wywołuje `ssh` i `wsl.exe`. Dzięki temu:
  - działa każdy silnik zgodny z CLI: Docker Engine, Docker Desktop (Windows / macOS), **Podman** (`podman`
    albo `podman-docker`), Colima, Rancher Desktop;
  - działają konteksty Dockera (`docker context`), w tym zdalny Docker przez SSH (`DOCKER_HOST=ssh://host`);
  - nie dochodzi zależność z runtime’em async (biblioteki Rust do API Dockera, np. `bollard`, wymagają tokio;
    backend Leverframe działa na wątkach – ten sam powód co przy ACP, zob. ACP.md § 4).
- **Kontener = profil.** Kontener z agentami jest nowym rodzajem profilu (obok lokalnego, WSL, SSH,
  PowerShell). Wszystko, co działa „w profilu”, działa wtedy w kontenerze: terminal, wykrywanie agentów,
  uruchamianie agenta, tryb rozmowy, nagrania.
- **Folder projektu jest montowany** (`-v <projekt>:/workspace`). Leverframe tłumaczy ścieżki kontenera na
  ścieżki komputera tak, jak dziś tłumaczy ścieżki WSL – dzięki temu edytor, diffy, „Pliki” i dostęp agenta do
  plików działają na tych samych plikach.
- **Leverframe nie przechowuje sekretów** (README, „Bezpieczeństwo”). Logowania agentów zostają w kontenerze –
  w nazwanych wolumenach, które przeżywają usunięcie kontenera.

## 3. Jak to wygląda dla użytkownika

1. Widok **Kontenery** (nowa ikona na pasku aktywności) pokazuje silnik (wersja, kontekst), obrazy i kontenery.
2. **Obraz z agentami**: „Pobierz” (np. `ghcr.io/tarze07/leverframe-agents:latest`, § 6) albo „Zbuduj” z
   własnego `Dockerfile` – z postępem w panelu.
3. **Nowy kontener** z obrazu: nazwa, folder projektu (domyślnie folder z panelu „Agenci”) montowany jako
   `/workspace`, wolumeny na logowania agentów (domyślnie włączone), zmienne środowiskowe, opcjonalnie porty
   i sieć. Leverframe tworzy kontener (`docker run -d … sleep infinity` / `tini`) i od razu **profil** dla niego.
4. Profil kontenera jest na liście profili w „Terminale” i w wyborze profilu w „Agenci”: terminal otwiera
   powłokę w kontenerze, „Terminal” / „Rozmowa” przy agencie uruchamia go w kontenerze. Zatrzymany kontener
   Leverframe uruchamia sam (po pytaniu albo zgodnie z ustawieniem).
5. Pierwsze logowanie agenta: raz w terminalu kontenera (np. `claude` → `/login`); dane zostają w wolumenie.
6. W „Kontenery”: start / stop / restart, logi kontenera, usunięcie (z pytaniem; wolumeny z logowaniami
   osobno), usunięcie nieużywanych obrazów.

## 4. Architektura

```
React UI ── invoke ──▶ Rust: DockerService ── docker CLI ──▶ silnik (lokalny / Desktop / Podman / zdalny kontekst)
   ▲  widok „Kontenery”,     │  obrazy, kontenery, wolumeny,
   │  profile kontenerów     │  postęp pull/build, logi
   │                         ▼
   │                  profil kontenera ──▶ PTY: docker exec -it … <powłoka>      (terminal, agent w terminalu)
   │                                   ──▶ potoki: docker exec -i … sh -c …     (tryb rozmowy ACP, wykrywanie)
   └──────── zdarzenia ◀────────────────┘
```

### 4.1 Moduł `src-tauri/src/docker`

- `cli.rs` – wywołanie `docker` (program z ustawień: `docker` albo `podman`; kontekst), parsowanie JSON z
  `--format`, błędy po polsku („Docker nie działa – uruchom Docker Desktop”, „brak uprawnień do gniazda”).
- `service.rs` – `DockerService`: `info()`, `images()`, `containers()`, `volumes()`, `pull(image, postęp)`,
  `build(dir, tag, postęp)`, `create(spec)`, `start/stop/restart/remove(id)`, `logs(id, follow)`,
  `inspect(id)` (montowania – do mapowania ścieżek), `prune_images()`.
- Postęp `pull` / `build` i `logs --follow` przez `Channel` (jak wyjście terminala).
- Komendy Tauri `docker_*`; operacje usuwające tylko z potwierdzeniem w UI.

### 4.2 Profil kontenera

`ProfileKind::Container` z polem `container: ContainerTarget`:

```json
{
  "id": "container:sklep-agenci",
  "name": "sklep (agenci)",
  "kind": "container",
  "container": {
    "name": "sklep-agenci",
    "engine": "docker",
    "context": null,
    "user": null,
    "shell": "/bin/bash",
    "workdir": "/workspace",
    "autoStart": true
  }
}
```

- **Terminal**: `docker exec -it -w <workdir> [-u <user>] <kontener> <powłoka> -l` w PTY (jak `ssh -t`).
- **Wykrywanie agentów**: ten sam skrypt POSIX co dziś (`agents/detect.rs`), uruchamiany przez
  `docker exec -i <kontener> sh -lc …`.
- **Tryb rozmowy (ACP)**: `acp/launch.rs` dostaje gałąź kontenera – `docker exec -i -w <katalog> <kontener>
  sh -c '<LOGIN_PATH_PRELUDE>; printf @@LF-CWD@@…; exec <agent>'`, bez PTY (potoki), jak dla WSL.
- **Profile wykryte**: działające kontenery z etykietą `io.leverframe.agents=1` (ustawianą przy tworzeniu
  w Leverframe) pojawiają się jako profile wykryte; inne kontenery można dodać ręcznie („Dodaj jako profil”).

### 4.3 Ścieżki i pliki

- `docker inspect` podaje montowania (`Mounts`: źródło na komputerze → cel w kontenerze). `FsKind` dostaje
  wariant `Container { mounts }`: ścieżka w kontenerze w zamontowanym katalogu → ścieżka na komputerze
  (np. `/workspace/src/a.ts` → `C:\projekty\sklep\src\a.ts`), a odwrotnie przy uruchamianiu
  (folder projektu → `-w /workspace`).
- Agent w trybie rozmowy czyta i zapisuje pliki **przez Leverframe** tylko w zamontowanych katalogach
  (z niezapisanymi zmianami edytorów, zgodami, diffami – jak lokalnie). Poza montowaniami pliku nie ma na
  komputerze: Leverframe odmawia, a agent korzysta z własnego dostępu (jak dziś na SSH).
- Ścieżki w kartach narzędzi i w logach agenta otwierają się w edytorze, jeśli są w montowaniu.
- Docker Desktop na Windows: źródła montowań to ścieżki Windows (`C:\…`), w WSL – ścieżki Linuksa; obie
  postacie są w `Mounts` i obie mapują się na pliki tego komputera.

### 4.4 Polecenia agenta (`terminal/*`)

Terminale agenta (ACP A5) w kontenerze to PTY z `docker exec -it -w <cwd> <kontener> sh -c '<polecenie>'`;
pytanie przed poleceniem, podgląd wyjścia i limit działają bez zmian.

### 4.5 Historia i logi agentów

- Nagrania terminala i transkrypty rozmów – bez zmian (profil kontenera jak każdy inny).
- Logi agentów (`~/.claude`, `~/.codex` w kontenerze) w panelu „Sesje → Rozmowy”: czytane przez
  `docker exec … cat` (lista jak dla SSH, `sessions/logs/ssh.rs`), a gdy katalog domowy jest w wolumenie –
  bez zmian w sposobie odczytu.

## 5. Zarządzanie obrazami i kontenerami (widok „Kontenery”)

| Sekcja | Co pokazuje | Działania |
|---|---|---|
| Silnik | program (`docker` / `podman`), wersja, kontekst, czy działa | wybór programu i kontekstu; podpowiedź instalacji / uruchomienia |
| Obrazy | repozytorium:tag, rozmiar, data, czy ma agentów (etykieta `io.leverframe.agents`) | Pobierz (z postępem), Zbuduj z `Dockerfile` (folder, tag), Nowy kontener, Usuń (z pytaniem), Usuń nieużywane |
| Kontenery | nazwa, obraz, stan, montowania, profil | Start / Stop / Restart, Terminal, Agenci, Logi kontenera, Dodaj jako profil, Usuń (z pytaniem; opcjonalnie z wolumenami) |
| Wolumeny | wolumeny Leverframe (logowania agentów) | Usuń (z pytaniem) |

Formularz **Nowy kontener**: obraz, nazwa, folder projektu → `/workspace`, wolumeny logowań
(`leverframe-<nazwa>-home` → katalog domowy użytkownika w kontenerze), zmienne środowiskowe (z ostrzeżeniem,
że trafiają do konfiguracji kontenera – na klucze lepiej logowanie w terminalu), porty, sieć, użytkownik,
„uruchamiaj przy otwarciu profilu”. Pod spodem `docker run -d --name … --label io.leverframe.agents=1
-v … -w /workspace <obraz> sleep infinity` (z `--init`), pokazywane użytkownikowi przed utworzeniem.

## 6. Obraz z agentami

W repozytorium `packaging/docker/agents/Dockerfile`:

- baza `node:22-bookworm-slim` (adapter Claude wymaga Node.js 22+), `git`, `ripgrep`, `openssh-client`,
  `tini`, `sudo`;
- agenci: `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, adaptery ACP
  `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` – w wersjach przypiętych
  (zasada: co najmniej 2 tygodnie od wydania), aktualizowanych świadomie;
- użytkownik bez uprawnień roota (`agent`, UID 1000 – pliki w zamontowanym folderze mają właściciela jak na
  komputerze w Linuksie; na Windows/macOS robi to Docker Desktop);
- etykieta `io.leverframe.agents=1`, katalog roboczy `/workspace`.

Workflow `docker-agents.yml` buduje obraz i publikuje go w GHCR (`ghcr.io/tarze07/leverframe-agents:<wersja>`
i `:latest`) – przy zmianach w `packaging/docker/agents` i przy wydaniu. Obraz jest punktem startowym:
projekty mogą mieć własny `Dockerfile` `FROM` tego obrazu z narzędziami projektu (Python, Rust, …).

## 7. Bezpieczeństwo

- **Dostęp do Dockera to praktycznie root na komputerze** (gniazdo `docker.sock`). Leverframe nie montuje
  gniazda w kontenerach, nie używa `--privileged` ani `--network host` domyślnie; takie opcje tylko świadomie
  w formularzu, z ostrzeżeniem.
- Montowany jest tylko wskazany folder projektu (domyślnie tylko on); ostrzeżenie przy montowaniu katalogu
  domowego lub `/`.
- Każda operacja usuwająca (obraz, kontener, wolumen z logowaniami) – z potwierdzeniem i nazwą tego, co znika.
- Sekrety: Leverframe ich nie przechowuje; logowania agentów w wolumenach kontenera. Zmienne środowiskowe
  z formularza są widoczne w `docker inspect` – UI to mówi.
- Polecenie `docker run` / `docker build` jest pokazywane przed wykonaniem; argumenty przekazywane jako lista
  (bez powłoki), nazwy i tagi walidowane.
- Obraz z agentami: użytkownik bez roota, przypięte wersje, publikacja tylko z workflow repozytorium.

## 8. Etapy

| Etap | Zakres | Wynik |
|---|---|---|
| **D1** | `DockerService` przez CLI: wykrycie silnika (Docker / Podman, wersja, konteksty), lista obrazów, kontenerów i wolumenów, `inspect`; atrapa CLI `docker` do testów; komunikaty o braku Dockera | Leverframe widzi Dockera i jego zasoby |
| **D2** | Widok „Kontenery”: obrazy i kontenery, pobieranie i budowanie z postępem, start / stop / restart / usuń, logi kontenera, formularz „Nowy kontener” (montowanie projektu, wolumeny logowań) | zarządzanie obrazami i kontenerami z aplikacji |
| **D3** | Profil kontenera (`ProfileKind::Container`): terminal w kontenerze (`docker exec -it`), automatyczny start zatrzymanego kontenera, profile wykryte (etykieta), „Dodaj jako profil” | terminal w kontenerze jednym kliknięciem |
| **D4** | Agenci w kontenerze: wykrywanie, uruchamianie w terminalu, nagrania sesji, logi agentów z kontenera w „Sesje” | agent w trybie terminalowym w kontenerze |
| **D5** | Tryb rozmowy w kontenerze: uruchamianie ACP przez `docker exec -i`, `FsKind::Container` (mapowanie montowań), polecenia agenta w PTY kontenera, otwieranie ścieżek w edytorze | rozmowa z agentem w kontenerze, zmiany plików pod kontrolą |
| **D6** | Obraz z agentami: `packaging/docker/agents/Dockerfile`, workflow publikujący w GHCR, „Pobierz obraz Leverframe” w widoku | gotowy obraz do pobrania |
| **D7** | Testy E2E na prawdziwym Dockerze (runner ubuntu ma Dockera) z atrapą agenta w obrazie testowym, ręczne sprawdzenie na Docker Desktop (Windows) i Podmanie, dokumentacja, wydanie | wersja z obsługą kontenerów |

Kolejność daje wartość po każdym etapie: po D3 można już pracować w kontenerze w terminalu, po D5 – w trybie
rozmowy. D6 można zrobić równolegle z D2–D5.

## 9. Ryzyka, decyzje i pytania otwarte

- **CLI czy API** – CLI (§ 2). Koszt: parsowanie wyjścia `--format`; zysk: Podman, konteksty, brak tokio.
- **Podman** – zgodny z CLI, ale `podman` bez demona inaczej obsługuje użytkowników (rootless, `--userns`);
  testy ręczne w D7.
- **Windows** – Docker Desktop daje `docker.exe` w PATH Windows; Docker w dystrybucji WSL (bez Desktop) to
  profil WSL + `docker` w środku – do obsłużenia przez wybór programu `wsl.exe -d <dystrybucja> docker`.
- **Uprawnienia plików** w montowaniu na Linuksie (UID kontenera ≠ UID użytkownika) – obraz z UID 1000,
  opcja „użytkownik” w formularzu; do sprawdzenia w D7.
- **Wydajność montowań** na Windows/macOS (Docker Desktop) – znana wolniejsza praca na dużych projektach;
  w dokumentacji: projekt w WSL dla Windows.
- Pytania do decyzji przed D2:
  1. Czy obsługiwać od razu **Podmana**, czy na start tylko Dockera?
  2. Kontener **trwały** (tworzony raz, profil wskazuje kontener) – jak w tej propozycji – czy także
     **jednorazowy** (`docker run --rm` przy każdym otwarciu terminala z obrazu)?
  3. Czy publikować **obraz z agentami** w GHCR (D6), czy wystarczy `Dockerfile` w repozytorium?
  4. Czy **zdalny Docker** (kontekst / `ssh://`) jest potrzebny w pierwszej wersji?
  5. Później: **Docker Compose** i **`devcontainer.json`** (VS Code Dev Containers) – czy są w planach?
