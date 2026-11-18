# Leverframe – propozycja: kontenery Docker z agentami

Dokument odpowiada na zadanie [#60](https://github.com/tarze07/Leverframe/issues/60): jak łączyć się z kontenerem
z obrazu, w którym są zainstalowani agenci, jak takie kontenery uruchamiać i jak zarządzać obrazami Dockera
z Leverframe. Uzupełnia [PLAN.md](PLAN.md) i [ACP.md](ACP.md). Etapy D1–D7 to zadania #63–#69 (§ 8).

**Stan:** D1–D9 (#63–#69, #79, #89) zrobione; D1–D7 wydane w 0.8.0, D8 w 0.9.0 (ręczne sprawdzenie na Docker Desktop w Windows – w PR wydania) – moduł `src-tauri/src/docker` (`cli.rs` – odczyt, `actions.rs` – nowy kontener
i zmiany, `jobs.rs` – pull / build / logs z postępem, `terminal.rs` – terminal profilu kontenera, ścieżki z montowań,
profile wykryte), widok „Kontenery”, profil `kind: "container"` (program `docker` z `dockerPath`), agenci w kontenerze
(wykrywanie przez `docker exec -i … sh -s`, terminal, logi Claude / Codex jako źródło `docker:<profil>`), ustawienie
`dockerPath`. Profile wykryte obejmują też zatrzymane kontenery z etykietą (ich terminal je uruchamia). Tryb rozmowy
(ACP) w kontenerze: `docker exec -i` (potoki), `FsKind::Container` – pliki agenta przez montowania (poza nimi odmowa,
a gdy katalog rozmowy nie jest zamontowany, agent dostaje własny dostęp do plików i poleceń, jak na SSH), polecenia
agenta w PTY przez `docker exec -it`; UI uruchamia zatrzymany kontener przed rozmową i mapuje ścieżki na pliki projektu. Obraz z
agentami: `packaging/docker/agents/Dockerfile` (wbudowany przez `include_str!`, `docker/image.rs`), przycisk „Zbuduj obraz
Leverframe” (`leverframe-agents:<wersja>`), workflow `docker-image.yml` z `check.sh` (wersje agentów, `initialize` adapterów).
E2E z prawdziwym Dockerem: `e2e/docker.test.mjs` (`npm run e2e:docker`, w CI po zwykłych E2E) – obraz testowy z busyboxa
i atrapy agenta ACP budowany w widoku, kontener, terminal, agent, rozmowa ze zmianą pliku przez edytor, historia.

**Decyzje (16.11.2026):** na początek **tylko Docker** (Podman później); obraz z agentami jako **`Dockerfile` w
repozytorium**, bez publikacji w rejestrze (GHCR). Pozostałe pytania z § 9 – na razie według tej propozycji.

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
  - działa Docker Engine i Docker Desktop (Windows / macOS) – to jest zakres pierwszej wersji; inne silniki
    zgodne z CLI (**Podman**, Colima, Rancher Desktop) można dodać później bez zmiany architektury;
  - konteksty Dockera (`docker context`, także zdalny Docker przez SSH) działają „przy okazji”, ale w pierwszej
    wersji nie są testowane ani wybierane w UI;
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
2. **Obraz z agentami**: „Zbuduj obraz Leverframe” z `Dockerfile` w repozytorium (§ 6), „Zbuduj” z własnego
   `Dockerfile` albo „Pobierz” dowolny obraz z rejestru – z postępem w panelu.
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
React UI ── invoke ──▶ Rust: DockerService ── docker CLI ──▶ Docker (Engine / Desktop)
   ▲  widok „Kontenery”,     │  obrazy, kontenery, wolumeny,
   │  profile kontenerów     │  postęp pull/build, logi
   │                         ▼
   │                  profil kontenera ──▶ PTY: docker exec -it … <powłoka>      (terminal, agent w terminalu)
   │                                   ──▶ potoki: docker exec -i … sh -c …     (tryb rozmowy ACP, wykrywanie)
   └──────── zdarzenia ◀────────────────┘
```

### 4.1 Moduł `src-tauri/src/docker`

- `cli.rs` – wywołanie `docker` (ścieżka programu z ustawień; później także `podman`), parsowanie JSON z
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
| Silnik | wersja Dockera, czy działa | ścieżka programu `docker`; podpowiedź instalacji / uruchomienia (Docker Desktop, Docker Engine) |
| Obrazy | repozytorium:tag, rozmiar, data, czy ma agentów (etykieta `io.leverframe.agents`) | Zbuduj obraz Leverframe, Zbuduj z `Dockerfile` (folder, tag), Pobierz (z postępem), Nowy kontener, Usuń (z pytaniem), Usuń nieużywane |
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
- agenci (#85: tylko Claude Code i OpenCode): `@anthropic-ai/claude-code` z adapterem ACP
  `@agentclientprotocol/claude-agent-acp` oraz `opencode-ai` (ACP wbudowany: `opencode acp`) – w wersjach przypiętych
  (zasada: co najmniej 2 tygodnie od wydania), aktualizowanych świadomie;
- użytkownik bez uprawnień roota (`agent`, UID 1000 – pliki w zamontowanym folderze mają właściciela jak na
  komputerze w Linuksie; na Windows/macOS robi to Docker Desktop);
- etykieta `io.leverframe.agents=1`, katalog roboczy `/workspace`.

Obraz **nie jest publikowany** w rejestrze (decyzja z 16.11.2026): użytkownik buduje go u siebie przyciskiem
„Zbuduj obraz Leverframe” (Leverframe ma `Dockerfile` w zasobach aplikacji) albo `docker build` z repozytorium.
CI buduje go przy zmianach w `packaging/docker/agents`, żeby wykryć zepsuty `Dockerfile`, i nic nie wysyła.
Obraz jest punktem startowym: projekty mogą mieć własny `Dockerfile` `FROM leverframe-agents` z narzędziami
projektu (Python, Rust, …). Publikacja w GHCR – do ewentualnej decyzji później.

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
| **D1** ([#63](https://github.com/tarze07/Leverframe/issues/63)) | `DockerService` przez CLI: wykrycie Dockera (wersja, czy działa), lista obrazów, kontenerów i wolumenów, `inspect`; atrapa CLI `docker` do testów; komunikaty o braku Dockera | Leverframe widzi Dockera i jego zasoby |
| **D2** ([#64](https://github.com/tarze07/Leverframe/issues/64)) | Widok „Kontenery”: obrazy i kontenery, pobieranie i budowanie z postępem, start / stop / restart / usuń, logi kontenera, formularz „Nowy kontener” (montowanie projektu, wolumeny logowań) | zarządzanie obrazami i kontenerami z aplikacji |
| **D3** ([#65](https://github.com/tarze07/Leverframe/issues/65)) | Profil kontenera (`ProfileKind::Container`): terminal w kontenerze (`docker exec -it`), automatyczny start zatrzymanego kontenera, profile wykryte (etykieta), „Dodaj jako profil” | terminal w kontenerze jednym kliknięciem |
| **D4** ([#66](https://github.com/tarze07/Leverframe/issues/66)) | Agenci w kontenerze: wykrywanie, uruchamianie w terminalu, nagrania sesji, logi agentów z kontenera w „Sesje” | agent w trybie terminalowym w kontenerze |
| **D5** ([#67](https://github.com/tarze07/Leverframe/issues/67)) | Tryb rozmowy w kontenerze: uruchamianie ACP przez `docker exec -i`, `FsKind::Container` (mapowanie montowań), polecenia agenta w PTY kontenera, otwieranie ścieżek w edytorze | rozmowa z agentem w kontenerze, zmiany plików pod kontrolą |
| **D6** ([#68](https://github.com/tarze07/Leverframe/issues/68)) | Obraz z agentami: `packaging/docker/agents/Dockerfile` (także w zasobach aplikacji), „Zbuduj obraz Leverframe” w widoku, budowanie obrazu w CI (bez publikacji) | obraz z agentami zbudowany jednym kliknięciem |
| **D7** ([#69](https://github.com/tarze07/Leverframe/issues/69)) | Testy E2E na prawdziwym Dockerze (runner ubuntu ma Dockera) z atrapą agenta w obrazie testowym, ręczne sprawdzenie na Docker Desktop (Windows), dokumentacja, wydanie | wersja z obsługą kontenerów |
| **D8** ([#79](https://github.com/tarze07/Leverframe/issues/79)) | Zdalny Docker przez SSH: źródło Dockera z profilu SSH (`DOCKER_HOST=ssh://…`), profile kontenerów zdalnych, folder projektu na serwerze, tryb rozmowy bez plików przez Leverframe, E2E ze zdalnym demonem (§ 10) | kontenery na serwerze z Leverframe na tym komputerze |
| **D9** ([#89](https://github.com/tarze07/Leverframe/issues/89)) | Docker przez SSH bez lokalnego klienta: `ssh host docker …` (tryb połączenia auto / klient / ssh), terminal, wykrywanie, logi i tryb rozmowy przez `ssh`, budowanie obrazu agentów z Dockerfile na stdin, E2E bez klienta (§ 11) | Docker na serwerze bez instalowania Dockera na tym komputerze |

Kolejność daje wartość po każdym etapie: po D3 można już pracować w kontenerze w terminalu, po D5 – w trybie
rozmowy. D6 można zrobić równolegle z D2–D5.

## 9. Ryzyka, decyzje i pytania otwarte

- **CLI czy API** – CLI (§ 2). Koszt: parsowanie wyjścia `--format`; zysk: Podman, konteksty, brak tokio.
- **Podman** – poza pierwszą wersją (decyzja z 16.11.2026). Jest zgodny z CLI, ale bez demona inaczej obsługuje
  użytkowników (rootless, `--userns`); po D7 osobne zadanie: wybór programu `podman` i testy.
- **Windows** – Docker Desktop daje `docker.exe` w PATH Windows; Docker w dystrybucji WSL (bez Desktop) to
  profil WSL + `docker` w środku – do obsłużenia przez wybór programu `wsl.exe -d <dystrybucja> docker`.
- **Uprawnienia plików** w montowaniu na Linuksie (UID kontenera ≠ UID użytkownika) – sprawdzone w D7: agent
  z UID 1000 nie zapisze folderu innego właściciela. „Nowy kontener” ostrzega i podaje `-u <UID>:<GID>` (pole
  „Użytkownik”); obraz ma `HOME=/home/agent` zapisywalny dla każdego UID, więc logowania działają i wtedy.
- **Wydajność montowań** na Windows/macOS (Docker Desktop) – znana wolniejsza praca na dużych projektach;
  w dokumentacji: projekt w WSL dla Windows.
- Pytania:
  1. ~~Podman od razu?~~ – **nie**, na początek tylko Docker.
  2. Kontener **trwały** (tworzony raz, profil wskazuje kontener) – jak w tej propozycji – czy także
     **jednorazowy** (`docker run --rm` przy każdym otwarciu terminala z obrazu)? *Na razie: trwały.*
  3. ~~Publikacja obrazu w GHCR?~~ – **nie**, `Dockerfile` w repozytorium.
  4. Czy **zdalny Docker** (kontekst / `ssh://`) jest potrzebny w pierwszej wersji? *Nie w pierwszej wersji –
     osobny etap D8 (§ 10, [#79](https://github.com/tarze07/Leverframe/issues/79)).*
  5. Później: **Docker Compose** i **`devcontainer.json`** (VS Code Dev Containers) – czy są w planach?
     *Na razie poza zakresem.*

## 10. Zdalny Docker przez SSH (D8)

Cel: Leverframe na tym komputerze, kontenery na innej maszynie (serwer, maszyna z GPU, mocniejszy komputer
w sieci). Widok „Kontenery”, terminal, agenci i tryb rozmowy działają jak lokalnie, a Docker i pliki projektu są
na serwerze.

**Stan (D8, #79):** zrobione wg 10.1–10.5 – `docker/remote.rs` (`DOCKER_HOST` z profilu SSH, ustawienie
`dockerSource`), `commands::current` / `for_profile`, `ContainerTarget.host`, `DOCKER_HOST` w środowisku profilu
kontenera (terminal, wykrywanie, logi, ACP), profile wykryte na serwerze (`container:<profil SSH>:<nazwa>`, cache do
odświeżenia), plan z folderem na serwerze (`on_ssh_host`), ACP bez `fs` / `terminal`. Pominięte: lista
`docker context ls` jako źródła (opcjonalne). Plik klucza z profilu SSH nie jest przekazywany (Docker CLI nie ma na to
opcji) – UI ostrzega, a dokumentacja odsyła do agenta SSH / `~/.ssh/config`.

### 10.1 Połączenie

- Docker CLI sam obsługuje demona przez SSH: `DOCKER_HOST=ssh://[user@]host[:port]` (albo `docker context` z takim
  adresem) – uruchamia `ssh … docker system dial-stdio` na serwerze. Leverframe nie potrzebuje własnego tunelu:
  dalej woła lokalny `docker`, tylko z tą zmienną środowiskową.
- **Źródło Dockera** wybierane w widoku „Kontenery”: „Ten komputer” albo profil SSH (host, użytkownik, port,
  klucz z profilu). Zmienna powstaje z danych profilu (walidacja: bez spacji i znaków powłoki, IPv6 w `[…]`).
  SSH bez pytania o hasło (`BatchMode`, klucz albo agent SSH) – jak przy profilach SSH.
- Warunek na serwerze: Docker i dostęp do niego dla użytkownika SSH (grupa `docker`); komunikat, gdy go nie ma
  (`docker info` przez SSH: „brak uprawnień”, „Docker nie działa”, „SSH nie łączy”).
- Opcjonalnie: lista `docker context ls` jako dodatkowe źródła (użytkownicy, którzy mają je już skonfigurowane).

### 10.2 Profile i polecenia

- `ContainerTarget` dostaje źródło (`host`: id profilu SSH; brak = lokalny Docker). Terminal (`docker exec -it`),
  wykrywanie agentów, logi agentów, logi kontenera i tryb rozmowy (`docker exec -i`) używają tego samego
  `DOCKER_HOST`.
- Profile wykryte: `container:<profil SSH>:<nazwa>`, grupa „Kontenery na <host>” w „Terminalach”; wykrywanie
  zdalnych kontenerów tylko dla wybranych źródeł (nie przy każdym budowaniu listy profili – SSH bywa wolne).

### 10.3 Folder projektu i pliki

- W „Nowy kontener” dla zdalnego Dockera folder projektu to **ścieżka na serwerze** (jak „Katalog na serwerze”
  profilu SSH, #26), wpisywana ręcznie – okno wyboru folderu pokazuje tylko ten komputer. Montowanie
  `-v <ścieżka na serwerze>:/workspace` wykonuje demon na serwerze.
- **Tryb rozmowy** jak przy SSH: bez `fs` i `terminal` od Leverframe – agent czyta i zapisuje pliki oraz uruchamia
  polecenia sam, w kontenerze (pliki projektu nie są na tym komputerze, `FsKind::Container` nie ma czego mapować).
  Ścieżki z rozmowy i z logów agentów nie otwierają się w lokalnym edytorze – UI to mówi.
- Później (osobne zadanie): pliki projektu przez SFTP w edytorze i w trybie rozmowy (zgody, diffy jak lokalnie).

### 10.4 Obrazy

- „Zbuduj obraz Leverframe” działa na zdalnym demonie: kontekst budowania (tylko `Dockerfile`) wysyła CLI.
  „Zbuduj…” z folderu: folder jest na tym komputerze, a kontekst idzie przez SSH – przy dużych folderach wolno;
  UI pokazuje rozmiar kontekstu z wyjścia budowania.
- Pobieranie obrazów i ich lista – na serwerze.

### 10.5 Testy

- Rust: `DOCKER_HOST` z profilu SSH (użytkownik, port, IPv6, odrzucane znaki), atrapa CLI `docker` sprawdzająca
  zmienną, profile zdalne, tryb rozmowy bez `fs` / `terminal`.
- E2E w CI ze zdalnym demonem: `sshd` na runnerze (klucz testowy, użytkownik w grupie `docker`) i źródło
  `ssh://…@localhost` – widok „Kontenery”, nowy kontener z folderem na „serwerze”, terminal, agent w terminalu,
  rozmowa z atrapą agenta.

### 10.6 Ryzyka

- **Opóźnienia SSH**: każde polecenie `docker` otwiera połączenie – lista, `inspect` i wykrywanie agentów mogą
  być wolne. Rozwiązanie: `ControlMaster` / `ControlPersist` w opcjach SSH dla `DOCKER_HOST` (Docker CLI
  korzysta z `~/.ssh/config`), krótsze odświeżanie tylko na żądanie.
- **Windows**: Docker CLI z `ssh://` używa `ssh.exe` z OpenSSH Windows – jak profile SSH; do sprawdzenia
  z Docker Desktop i bez niego (sam `docker.exe`).
- **Bezpieczeństwo**: dostęp do Dockera na serwerze to w praktyce root na serwerze – opis w UI przy wyborze
  źródła; te same zasady co lokalnie (bez gniazda w kontenerach, bez `--privileged`, potwierdzenia).

## 11. Docker przez SSH bez lokalnego klienta (D9)

**Stan (D9, #89):** zrobione. D8 wymaga programu `docker` na tym komputerze (`DOCKER_HOST=ssh://…` obsługuje
klient). Na komputerze bez Dockera Leverframe uruchamia `docker` **na serwerze** przez `ssh`:

- **Tryb połączenia** – ustawienie `dockerSshMode`: `auto` (domyślnie: klient, gdy `docker` z ustawienia
  `dockerPath` jest na tym komputerze, inaczej `ssh`), `client` (zawsze `DOCKER_HOST`), `ssh` (zawsze przez
  `ssh`). W widoku „Kontenery” pole **Połączenie** pod „Docker na” (gdy wybrany jest profil SSH).
- **Polecenia** – `remote::ssh_command` (program `ssh` profilu, `-o BatchMode=yes -o ConnectTimeout=15`, `-p`,
  `-i` z profilu – w przeciwieństwie do `DOCKER_HOST` klucz z profilu działa), `over_ssh` dokleja `-T`
  (polecenia, wykrywanie, logi, tryb rozmowy) albo `-tt` (terminal) i jedno polecenie powłoki serwera
  `docker <argumenty>` z każdym argumentem w apostrofach (`remote_docker`). `Docker::via_ssh` – cała warstwa
  CLI (lista, `inspect`, akcje, zadania) idzie tą drogą.
- **Profile kontenerów na serwerze** – zamiast `DOCKER_HOST` w środowisku profilu jest `LEVERFRAME_DOCKER_SSH`
  (polecenie `ssh` jako JSON; znacznik Leverframe, nie trafia do procesu); `remote::invocation` składa
  `ssh -tt … docker exec -it …` (terminal, także z folderem projektu), `ssh -T … docker exec -i … sh -s`
  (wykrywanie agentów, logi agentów) i `ssh -T … docker exec -i … sh -c '…'` (tryb rozmowy).
- **Budowanie** – „Zbuduj obraz Leverframe” wysyła Dockerfile na stdin (`docker build --progress=plain -t
  leverframe-agents:<wersja> -`; Dockerfile niczego nie kopiuje) – w obu trybach, bez folderu tymczasowego.
  „Zbuduj…” z folderu tego komputera jest w trybie `ssh` wyłączone (Docker na serwerze nie widzi tych plików).
  Przerwanie zadania zamyka `ssh`, a z nim budowanie na serwerze.
- **Błędy** – kod 255 `ssh` → „Połączenie SSH z serwerem Dockera nie działa: … (logowanie bez pytania, known_hosts)”;
  127 → „na serwerze nie ma programu docker”; brak programu `ssh` → prośba o klienta OpenSSH; brak uprawnień
  (grupa `docker`) jak lokalnie.
- **Testy** – Rust: wybór trybu, budowanie polecenia `ssh` (port, klucz ze spacją, `-T`/`-tt`), cytowanie
  sprawdzone przez atrapę `ssh` (wykonuje polecenie przez `sh -c`) i atrapę `docker` wypisującą argumenty, błędy
  255 / 127 / brak `ssh`, zadanie z danymi na stdin. E2E: scenariusz „Docker na hoście SSH” drugi raz z
  `dockerPath` wskazującym nieistniejący program (auto → `ssh`), z budowaniem obrazu agentów przerwanym po
  starcie.
