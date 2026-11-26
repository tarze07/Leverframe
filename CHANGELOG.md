# Zmiany

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), numeracja zgodna z [SemVer](https://semver.org/lang/pl/).

## [Unreleased]

### Dodane
- **Kopiowanie ścieżki i nazwy pliku z drzewa plików** ([#121](https://github.com/tarze07/Leverframe/issues/121)): menu pliku lub folderu (prawy przycisk albo ⋮) z „Kopiuj ścieżkę”, „Kopiuj ścieżkę względną” (względem folderu projektu) i „Kopiuj nazwę” oraz – dla folderów – „Nowy plik / Nowy folder tutaj…” i „Usuń…”; skróty Shift+Alt+C i Ctrl+Shift+Alt+C jak w VS Code; przyciski kopiowania ścieżki na pasku edytora, polecenia w palecie i „Kopiuj ścieżkę folderu projektu”. Potwierdzenie „Skopiowano: …”. Separator ścieżek względnych w Ustawieniach (`relativePathSeparator`: systemowy albo `/`).

## [0.14.1] – 2026-11-26

### Naprawione
- **Edytor bez kolorowania składni, z liniami rysowanymi jedna na drugiej** (regresja 0.14.0): ekran startowy z #115 był wbudowanym `<style>`/`<script>` w `index.html`; Tauri dopisał ich skróty do CSP, a przeglądarka przy skrótach ignoruje `'unsafe-inline'` – odrzucała więc style, które edytor (Monaco) dodaje w trakcie pracy (kolory, układ linii, kursor). Ekran startowy jest teraz w plikach `start.css` i `start.js`; test E2E sprawdza kolory składni i położenie nowej linii.
- **Losowe opóźnienia przy Dockerze przez SSH i w rozmowach** (regresja 0.14.0): polecenia przeniesione w #115 z wątku okna do środowiska async (terminal, Docker) wykrywały profile – także przez `ssh` na serwer – w jego nielicznych wątkach, przez co inne polecenia i zdarzenia (np. rozmowy z agentem) czekały. Wykrywanie i wyszukiwanie profili działa teraz w wątkach dla pracy blokującej (`spawn_blocking`): terminal, polecenia Dockera, lista i odświeżanie profili, wykrywanie agentów, start rozmowy, logi agentów, kopie zadań.

## [0.14.0] – 2026-11-26

### Dodane
- **Własne foldery zadań** ([#114](https://github.com/tarze07/Leverframe/issues/114)): w Ustawieniach „Zadania: folder w projekcie” (`tasksProjectDir`, ścieżka względna, domyślnie `.leverframe/tasks`) i „Zadania: folder zadań globalnych” (`tasksGlobalDir`, dowolny folder, np. w OneDrive). Zmiana folderu z zadaniami pyta, czy je przenieść (bez nadpisywania; zajęty numer dostaje kolejny). Do `.git/info/exclude` trafia ustawiony folder (opcja „Zadania projektu poza repozytorium”, `tasksExcludeFromGit`); kopie na serwerze SSH i w kontenerze idą do folderu o tej samej nazwie. „Otwórz folder zadań” w widoku „Zadania”.

### Naprawione
- **Pusty ekran przez kilka sekund przy uruchomieniu** ([#115](https://github.com/tarze07/Leverframe/issues/115)): pierwszy terminal uruchamiał się w wątku okna i czekał na wykrycie profili (WSL, `~/.ssh/config`, kontenery Docker – także na serwerze SSH), więc okno nie mogło się narysować (np. 4,3 s przy wolnym Dockerze). Terminal i polecenia Dockera, które wykrywają profile, działają teraz w tle, a profile są wykrywane od razu przy starcie, równolegle z wczytywaniem interfejsu (przy wolnym Dockerze interfejs jest po ~0,6–1,3 s). Do czasu narysowania interfejsu okno pokazuje „Uruchamianie Leverframe…” w kolorach ostatniego motywu zamiast pustej strony. `LEVERFRAME_TRACE_STARTUP=1` wypisuje czasy kolejnych etapów startu.

## [0.13.0] – 2026-11-25

### Dodane
- **Lista zadań – widok „Zadania”** ([#104](https://github.com/tarze07/Leverframe/issues/104), [#105](https://github.com/tarze07/Leverframe/issues/105), [#106](https://github.com/tarze07/Leverframe/issues/106)): nowa ikona na pasku aktywności z listą zadań projektu albo globalną (przełącznik „Projekt / Globalne”). Zadanie to plik Markdown z krótkim nagłówkiem (numer, tytuł, status, data): w projekcie w `.leverframe/tasks/`, globalne w danych aplikacji. Zadania pogrupowane według statusu (Do zrobienia / W toku / Do sprawdzenia / Gotowe) z licznikami i filtrem; „Nowe zadanie…” tworzy plik z szablonem i otwiera go w edytorze; menu zadania (także pod prawym przyciskiem) zmienia status, przenosi między projektem a globalnymi i usuwa (do kosza albo na stałe). Lista odświeża się po zapisaniu pliku zadania w edytorze. Folder `.leverframe/` nie trafia do repozytorium: Leverframe dopisuje go do `.git/info/exclude` (bez zmian w `.gitignore`). Polecenia „Zadania: pokaż” i „Zadania: nowe zadanie” w palecie poleceń.
- **Agent na zadaniu** ([#107](https://github.com/tarze07/Leverframe/issues/107), [#108](https://github.com/tarze07/Leverframe/issues/108), [#109](https://github.com/tarze07/Leverframe/issues/109)): „Uruchom agenta…” przy zadaniu – wybór agenta, profilu (lokalny, WSL, SSH, kontener lokalny i na serwerze), trybu i folderu pracy (zadania globalne). Tryb rozmowy sam wysyła pierwszą wiadomość z plikiem zadania jako zasobem (`resource_link`); tryb terminala uruchamia agenta z poleceniem jako pierwszym promptem (nowe pole `promptArg` w `agents.json`: Claude Code, Codex, Gemini CLI `-i`, OpenCode `--prompt`). Polecenie ustawia się w Ustawieniach („Zadania: polecenie dla agenta”, `tasksPrompt`, z `{plik}` i `{tytul}`). Kontener widzi plik przez zamontowany folder projektu; na serwer SSH i do kontenera bez tego folderu plik jest kopiowany (`.leverframe/tasks/`, z wpisem w `.git/info/exclude`), a „Pobierz wynik” pokazuje różnice kopii agenta i zapisuje ją w zadaniu po potwierdzeniu. Uruchomienia są zapisywane w nagłówku zadania (`runs`) i widoczne na liście „Uruchomienia” (trwające otwierają rozmowę lub terminal, zakończone – historię sesji). Zadanie przechodzi samo na „W toku” przy starcie i na „Do sprawdzenia”, gdy agent skończy; liczba zadań do sprawdzenia jest na ikonie widoku.

### Naprawione
- **Windows: agenci zainstalowani poza `PATH` Leverframe** (np. Claude Code w `%USERPROFILE%\.claude\bin`): Leverframe dziedziczył `PATH` z chwili logowania, więc foldery dopisane później do `PATH` użytkownika lub systemu (instalator, polityka firmowa) były pomijane – agent był „niezainstalowany”, a w terminalu nie startował. Przy starcie Leverframe uzupełnia `PATH` o ścieżki z rejestru i o istniejące foldery instalacji agentów (`.claude\bin`, `.claude\local`, `.local\bin`, `.opencode\bin`, `AppData\Roaming\npm`); dziedziczą go wykrywanie, terminale i tryb rozmowy.

## [0.12.0] – 2026-11-20

### Dodane
- **Kopiowanie z widoków sesji** ([#101](https://github.com/tarze07/Leverframe/issues/101)): tekst rozmowy z logu agenta da się zaznaczać i kopiować (Ctrl+C); przyciski „Kopiuj” przy wiadomościach, wynikach i narzędziach oraz „Kopiuj rozmowę” (cała rozmowa jako Markdown, z rozumowaniem, gdy jest pokazane). W nagraniu sesji Ctrl+C / Ctrl+Shift+C kopiuje zaznaczenie, a „Kopiuj tekst terminala” – cały tekst do bieżącej chwili nagrania (bez kodów sterujących). Potwierdzenie „Skopiowano” albo komunikat o błędzie schowka.
- **Wybór katalogu na komputerze zdalnym** ([#100](https://github.com/tarze07/Leverframe/issues/100)): przycisk „Wybierz…” przy „Katalog na serwerze” (panel „Agenci”, profile SSH – także z `~/.ssh/config`) i przy folderze projektu w „Nowy kontener” na serwerze otwiera przeglądanie folderów serwera przez SSH: w górę i w głąb, ścieżka wpisana ręcznie, ukryte foldery, nowy folder, „Wybierz ten folder”. Czytelne błędy (brak folderu, brak dostępu, brak połączenia).

## [0.11.0] – 2026-11-20

### Dodane
- **Tworzenie i usuwanie plików oraz folderów w panelu „Pliki”** ([#97](https://github.com/tarze07/Leverframe/issues/97)): „Nowy plik…” i „Nowy folder…” (w ostatnio klikniętym folderze, nazwa może zawierać `/`; nowy plik otwiera się w edytorze, nic nie jest nadpisywane), usuwanie z potwierdzeniem do kosza systemowego albo na stałe – tylko wewnątrz folderu projektu; edytory usuniętych plików się zamykają.
- **Zmiana folderu projektu w panelu „Pliki”**: nazwa folderu na górze panelu rozwija menu z „Otwórz folder…” i listą ostatnio otwieranych folderów (także na ekranie bez wybranego folderu).

### Zmienione
- **Systemowa ramka okna domyślnie na Windows**: okno bez ramki drżało przy skalowaniu ekranu innym niż 100% (np. 125%) w oknie niezmaksymalizowanym – na ramce systemowej problem znika (potwierdzone na Windows). Pasek tytułu Leverframe można przywrócić w Ustawieniach („Ramka okna”); na Linuksie i macOS domyślny pozostaje pasek Leverframe.

## [0.10.2] – 2026-11-19

### Naprawione
- **Drżenie terminala i edytora przy skalowaniu ekranu 125%** (Windows, okno niezmaksymalizowane): terminal, terminal agenta, edytor i podgląd zmian dopasowują się do rozmiaru tylko przy zmianie o pełny piksel – ułamkowe rozmiary okna nie wywołują już pętli dopasowywania.
- **Drżenie podglądu Markdown** (widok „Tekst i podgląd obok” przy skalowaniu 125%): podgląd ma stałe miejsce na pasek przewijania, więc jego pojawianie się nie zmienia szerokości tekstu i nie zawija go na przemian.
- **Logi kontenera bez wpisów** ([#94](https://github.com/tarze07/Leverframe/issues/94)): panel „Logi” kontenera, który nic nie wypisał (np. kontenery Leverframe – tylko czekają), pokazywał w nieskończoność „Wczytywanie…”. Teraz mówi, że w logu nie ma jeszcze wpisów i gdzie jest wyjście agentów.

### Dodane
- **Ramka okna** w ustawieniach: „Pasek tytułu Leverframe” (domyślnie) albo „Systemowa”. Systemowa ramka to obejście drżenia okna przy skalowaniu ekranu innym niż 100% na Windows (okno niezmaksymalizowane).

## [0.10.1] – 2026-11-18

### Naprawione
- **Docker na serwerze z profili `~/.ssh/config`**: hosty wykryte z `~/.ssh/config` nie pojawiały się w polu „Docker na” widoku „Kontenery” (0.9.0–0.10.0) – na komputerze bez Dockera nie dało się więc wybrać serwera. Teraz są źródłem Dockera (połączenie po aliasie: użytkownik, port i klucz z konfiguracji). Bez lokalnego Dockera widok podpowiada wybór serwera albo dodanie profilu SSH.

## [0.10.0] – 2026-11-18

### Dodane
- **Rozmowy OpenCode i Agy w historii** ([#88](https://github.com/tarze07/Leverframe/issues/88)): panel „Sesje” → „Rozmowy” pokazuje sesje OpenCode (z jego bazy SQLite; na hostach SSH i w kontenerach przez `opencode db`) i Agy (transkrypty `transcript_full.jsonl`, folder z `history.jsonl`) – z osią czasu i wznawianiem (`opencode --session`, `agy --conversation`).
- **Docker przez SSH bez lokalnego klienta** ([#89](https://github.com/tarze07/Leverframe/issues/89)): na komputerze bez programu `docker` Leverframe uruchamia `docker` na serwerze przez `ssh` (pole „Połączenie” w widoku „Kontenery”: automatycznie / klient / ssh) – obrazy, kontenery, terminale, agenci, logi, tryb rozmowy i budowanie obrazu z agentami (Dockerfile przez stdin); działa klucz z profilu SSH, czytelne błędy połączenia i braku `docker` na serwerze.

## [0.9.0] – 2026-11-17

### Dodane
- **Docker na serwerze przez SSH** ([#79](https://github.com/tarze07/Leverframe/issues/79), etap D8 obsługi Dockera): pole „Docker na” w widoku „Kontenery” wybiera Docker tego komputera albo serwera z profilu SSH (`DOCKER_HOST=ssh://…`). Obrazy, kontenery, budowanie, terminale, wykrywanie agentów, logi i tryb rozmowy działają na serwerze; folder projektu nowego kontenera to ścieżka na serwerze; kontenery Leverframe na serwerze są profilami „nazwa (serwer)”. W rozmowie agent korzysta z plików serwera sam. Logowanie bez pytania (klucz w agencie SSH albo w `~/.ssh/config`) – szczegóły w [README](https://github.com/tarze07/Leverframe#kontenery-docker). Test E2E z Dockerem przez SSH w CI.

### Zmienione
- **Obraz z agentami** ([#85](https://github.com/tarze07/Leverframe/issues/85)) zawiera tylko Claude Code (z `claude-agent-acp`) i OpenCode 1.19.5 (tryb rozmowy wbudowany) – bez Codex i Gemini CLI; obraz jest mniejszy (ok. 1,9 GB). Innych agentów można doinstalować we własnym obrazie `FROM leverframe-agents`.

### Poprawione
- Otwarcie nowego terminala nie zmienia już układu okna: zmaksymalizowany panel terminala zostaje zmaksymalizowany (wcześniej wracał edytor).

## [0.8.1] – 2026-11-17

### Poprawione
- Windows: terminal kontenera nie startował z Docker Desktop zainstalowanym dla użytkownika („%1 nie jest prawidłową aplikacją systemu Win32”) – w folderze Dockera obok `docker.exe` leży skrypt `docker` dla WSL, a terminal wybierał skrypt. Programy terminali są teraz szukane w `PATH` najpierw jako `.exe` / `.com`.

## [0.8.0] – 2026-11-17

### Dodane
- **Kontenery Docker** ([#60](https://github.com/tarze07/Leverframe/issues/60)) – agenci w izolowanym środowisku, z Leverframe na tym komputerze:
  - **Wykrywanie Dockera** ([#63](https://github.com/tarze07/Leverframe/issues/63)): wersja, czy działa – z podpowiedzią, gdy nie działa lub brakuje uprawnień; ustawienie **Program Docker** (`dockerPath`).
  - **Widok „Kontenery”** ([#64](https://github.com/tarze07/Leverframe/issues/64)): obrazy, kontenery i wolumeny Leverframe; pobieranie i budowanie obrazów z postępem (z przerwaniem; folder w „Zbuduj…” można wybrać, wpisać lub wkleić), **Nowy kontener** z folderem projektu jako `/workspace` i wolumenem na logowania agentów – z podglądem polecenia `docker run` i ostrzeżeniami przed utworzeniem; uruchamianie, zatrzymywanie, ponowne uruchamianie, logi kontenera na żywo, usuwanie po potwierdzeniu.
  - **Terminal w kontenerze** ([#65](https://github.com/tarze07/Leverframe/issues/65)): nowy rodzaj profilu – kontener (`docker exec`), w folderze projektu, gdy jest zamontowany. Kontenery utworzone w Leverframe są profilami od razu (grupa „Kontenery” w „Terminalach”), inne można dodać („Dodaj jako profil”). Zatrzymany kontener uruchamia się przy otwarciu terminala (albo po pytaniu, gdy profil tak ustawia).
  - **Agenci w kontenerze** ([#66](https://github.com/tarze07/Leverframe/issues/66)): panel „Agenci” wykrywa agentów w kontenerze i uruchamia ich w jego terminalu, w folderze projektu. Logi Claude Code i Codex z kontenera są w „Sesje → Rozmowy” (źródło „Kontener: …”), z otwieraniem plików z montowanego folderu i wznawianiem rozmowy w kontenerze.
  - **Rozmowa z agentem w kontenerze** ([#67](https://github.com/tarze07/Leverframe/issues/67)): tryb rozmowy (ACP) przez `docker exec`, w folderze projektu w kontenerze. Pliki z zamontowanego folderu agent czyta i zapisuje przez Leverframe (diffy, zgody, niezapisane zmiany edytora), pliki tylko w kontenerze są odrzucane, a polecenia agenta wykonują się w kontenerze. Zatrzymany kontener uruchamia się przed rozmową.
  - **Obraz z agentami** ([#68](https://github.com/tarze07/Leverframe/issues/68)): przycisk „Zbuduj obraz Leverframe” buduje `leverframe-agents:0.8.0` z wbudowanego pliku `Dockerfile` (`packaging/docker/agents`) – Node.js 22, Claude Code, Codex, Gemini CLI i adaptery trybu rozmowy w przypiętych wersjach, użytkownik `agent`, `/workspace`. Kontener z niego od razu ma wykrywanych agentów i tryb rozmowy. Obraz nie jest publikowany w rejestrze.
  - **Uprawnienia plików w Linuksie** ([#69](https://github.com/tarze07/Leverframe/issues/69)): „Nowy kontener” ostrzega, gdy folder projektu należy do innego UID niż agenci w obrazie Leverframe (1000), i podaje wartość pola *Użytkownik*; katalog domowy w obrazie jest zapisywalny dla każdego UID.
  - Testy E2E z prawdziwym Dockerem w CI ([#69](https://github.com/tarze07/Leverframe/issues/69)): budowanie obrazu w widoku, kontener z folderem projektu, stop / start, terminal, agent w terminalu, rozmowa zmieniająca plik przez edytor, wznowienie z historii, usunięcie. README: wymagania, pliki w Linuksie, Docker Desktop w Windows, bezpieczeństwo ([docs/DOCKER.md](https://github.com/tarze07/Leverframe/blob/main/docs/DOCKER.md)).
- **OpenCode** w panelu „Agenci” ([#78](https://github.com/tarze07/Leverframe/issues/78)): wykrywanie (`opencode --version`), uruchamianie w terminalu i tryb rozmowy (`opencode acp`, z wczytywaniem i wznawianiem sesji).
- **Ustawienia agenta** (przycisk ⚙ na karcie w „Agentach”, [#78](https://github.com/tarze07/Leverframe/issues/78)): argumenty w terminalu, zmienne środowiskowe (terminal i tryb rozmowy, każdy rodzaj profilu), program i argumenty trybu rozmowy, ukrywanie agenta (lista „Ukryci agenci”). Zapis jako nadpisania w `agents.json`; *Przywróć domyślne*.

### Zmienione
- Kilo Code usunięty z wbudowanych agentów – zastąpił go OpenCode (Kilo Code można dodać w `agents.json`) ([#78](https://github.com/tarze07/Leverframe/issues/78)).
- `"disabled": true` w `agents.json` ukrywa agenta zamiast go usuwać – można go pokazać z panelu „Agenci” ([#78](https://github.com/tarze07/Leverframe/issues/78)).

### Poprawione
- Lista rozmów z hosta SSH, który nie wykonał skryptu (np. przerwane połączenie), kończy się komunikatem zamiast pustej listy.

## [0.7.1] – 2026-11-16

Paczka dla Arch Linux i licencja MIT.

### Dodane
- **Paczka dla Arch Linux** w wydaniach: `leverframe-<wersja>-1-x86_64.pkg.tar.zst` (`sudo pacman -U ./plik.pkg.tar.zst`). To ta sama binarka co w `.deb`, z zależnościami Arch (WebKitGTK 4.1, GTK 3); workflow wydania instaluje ją na próbę w kontenerze Arch i sprawdza biblioteki. Do istniejącego wydania można ją dodać ręcznym uruchomieniem workflow z opcją `arch_only` (tak dodano ją do 0.7.0).
- Licencja **MIT** ([LICENSE](LICENSE)). Jest też w `Cargo.toml` i `package.json` (stąd trafia do metadanych instalatorów), w paczce dla Arch Linux (`license=MIT` i plik w `/usr/share/licenses/leverframe`) i w archiwum portable (`LICENSE.txt`).

## [0.7.0] – 2026-11-13

Widok „Rozmowy”, w którym zamknięcie karty nie kończy już rozmowy z agentem, oraz sprawdzenie trybu rozmowy z prawdziwymi agentami ([#42](https://github.com/tarze07/Leverframe/issues/42)). Zamyka etapy epiku ACP ([#35](https://github.com/tarze07/Leverframe/issues/35)).

### Dodane
- README: wymagania adapterów (Node.js), logowanie w Codex, Gemini i Claude, tryby Claude (*Auto* / *Manual*), ograniczenia w WSL i SSH.
- Test `real_acp_agents` (uruchamiany ręcznie) sprawdza prawdziwego agenta przez klienta Leverframe: logowanie, sesję, zadanie z plikiem i poleceniem, wznowienie i listę sesji. Wyniki dla Claude, Codex i Gemini CLI są w [docs/ACP.md](docs/ACP.md).
- Nowe testy E2E: odrzucona zmiana pliku, zmiana wprowadzona własnym narzędziem agenta, awaria agenta i kod wyjścia w historii.

### Zmienione
- **Widok „Rozmowy”** na pasku aktywności: lista otwartych rozmów z agentami (agent, temat, folder, stan, znacznik „czeka na decyzję” i licznik na ikonie). Kliknięcie przełącza na rozmowę lub otwiera jej kartę ponownie, pokazując koniec rozmowy – tak samo jak kliknięcie karty rozmowy (także już aktywnej). **Zamknięcie karty nie kończy już rozmowy** – agent pracuje dalej, a rozmowę kończy przycisk *Zakończ* w tym widoku.

### Poprawione
- Gdy agent zmienia plik własnym narzędziem (jak adapter Claude), a nie przez Leverframe, otwarty edytor bez niezapisanych zmian wczytuje nową treść, a drzewo „Pliki” się odświeża. Wcześniej edytor pokazywał starą treść aż do próby zapisu.

## [0.6.0] – 2026-11-12

Rozmowy z agentami (ACP) w historii, z wyszukiwaniem i wznawianiem ([#41](https://github.com/tarze07/Leverframe/issues/41)), polecenia agenta w terminalach Leverframe ([#40](https://github.com/tarze07/Leverframe/issues/40)) i większe pole wiadomości.

### Dodane
- **Historia rozmów z agentami** ([#41](https://github.com/tarze07/Leverframe/issues/41)): rozmowy w trybie ACP trafiają do panelu „Sesje” (zakładka **Historia**, dawniej „Nagrania”) obok nagrań terminala, z oznaczeniem rodzaju, tytułem i filtrem „Rodzaj”. Wyszukiwanie obejmuje treść wiadomości (także bez polskich znaków). Rozmowę z historii otwiera się tylko do odczytu, a **Wznów rozmowę** kontynuuje ją, jeśli agent pozwala wczytywać sesje (`session/load` / `session/resume`). Przycisk **Rozmowy agenta** otwiera sesje zapisane przez samego agenta (`session/list`) i – na wyraźne żądanie – usuwa je u agenta (`session/delete`). Zapis rozmowy wyłącza to samo ustawienie co nagrania terminala; pusta rozmowa (bez wiadomości) nie trafia do historii.
- **Polecenia agenta w terminalach Leverframe** ([#40](https://github.com/tarze07/Leverframe/issues/40)): w trybie rozmowy (profile lokalne i WSL) agent uruchamia polecenia przez Leverframe – po pytaniu (**Uruchom** / **Zawsze dla tego polecenia** / **Odmów**; pytanie można wyłączyć w ustawieniach). Wyjście widać na żywo w karcie narzędzia, a „Otwórz jako terminal” pokazuje je w panelu terminala. Agent dostaje czysty tekst przycięty do swojego limitu, kod wyjścia i może polecenie zatrzymać; zamknięcie rozmowy kończy jego polecenia.
- **Większe pole wiadomości w rozmowie z agentem**: rośnie razem z tekstem (do 40% panelu), przycisk obok pola powiększa je na większość panelu i z powrotem, a uchwyt nad polem pozwala przeciągnąć je wyżej – wysokość jest zapamiętywana, dwuklik na uchwycie przywraca automatyczną (także strzałki ↑/↓ na uchwycie).

## [0.5.0] – 2026-11-11

Tryb rozmowy z agentami przez [Agent Client Protocol](https://agentclientprotocol.com) (epik [#35](https://github.com/tarze07/Leverframe/issues/35)): agent pracuje w tle, a rozmowa, zgody i zmiany plików są w oknach Leverframe. Tryb jest nowy – jeśli prawdziwy agent zachowa się inaczej, niż opisano, zgłoś to w Issues.

### Dodane
- **Tryb rozmowy (Agent Client Protocol)** ([#36](https://github.com/tarze07/Leverframe/issues/36), [#37](https://github.com/tarze07/Leverframe/issues/37)): przycisk **Rozmowa** w panelu „Agenci” (i polecenie „Rozmowa z …” w palecie) uruchamia agenta w tle i prowadzi rozmowę w panelu Leverframe – z prośbami o zgodę, przerwaniem (Stop), logowaniem i logiem agenta. Działa w profilach lokalnych, WSL i SSH.
- **Gemini CLI** jako nowy agent (terminal i tryb rozmowy).
- Tryb rozmowy Claude Code i Codex przez oficjalne adaptery (`claude-agent-acp`, `codex-acp`); panel „Agenci” pokazuje, czy są zainstalowane, i podpowiada instalację. Pole `acp` w `agents.json`.
- **Pełny panel rozmowy** ([#38](https://github.com/tarze07/Leverframe/issues/38)): odpowiedzi jako Markdown (oczyszczany jak podgląd plików; linki otwierają się w przeglądarce lub edytorze), rozwijane rozumowanie, plan agenta ze statusem kroków, karty wywołań narzędzi (rodzaj, status, wynik, pliki z numerem linii – otwierane w edytorze, także z WSL), komendy agenta po wpisaniu `/`, wybór trybu i opcji agenta (np. modelu), zużycie kontekstu i koszt, przyczyna nietypowego końca tury, podpowiedź instalacji, gdy brakuje programu agenta. Rozmowę można otworzyć także w panelu terminala.
- **Zmiany plików pod kontrolą** ([#39](https://github.com/tarze07/Leverframe/issues/39)): agent czyta i zapisuje pliki przez Leverframe – z niezapisanymi zmianami z otwartych edytorów, z zapisem jako jedna zmiana do cofnięcia i z wykrywaniem konfliktów. Prośba o zgodę pokazuje polecenie i zmianę jako diff (+/− linii, fragment, „Otwórz zmianę” – widok obok siebie); opcje wybiera się też klawiszami 1–9; zakładka czekającej rozmowy ma znacznik ⚑. Dostęp bez pytania tylko w folderze projektu (`..` i dowiązania symboliczne sprawdzane); o pliki spoza niego Leverframe pyta. Drzewo „Pliki” odświeża się po zapisie agenta.

### Zmienione
- Przycisk uruchamiający agenta w terminalu nazywa się teraz **Terminal**.

### Poprawione
- Po otwarciu pliku (np. z drzewa „Pliki”) kursor czasem nie trafiał do edytora i pisanie nic nie dawało, dopóki nie kliknęło się w tekst. Edytor ponawia teraz przejęcie fokusu, gdy panel na chwilę jest ukryty podczas przeliczania układu.

## [0.4.0] – 2026-11-10

Zapisywanie i podgląd Markdown w edytorze ([#31](https://github.com/tarze07/Leverframe/issues/31), [#32](https://github.com/tarze07/Leverframe/issues/32)), bez ponownego wykrywania agentów po nieudanej próbie ([#29](https://github.com/tarze07/Leverframe/issues/29)).

### Dodane
- **Zapisywanie plików** ([#31](https://github.com/tarze07/Leverframe/issues/31)): pasek nad edytorem z przyciskiem „Zapisz” i informacją o niezapisanych zmianach; polecenia „Zapisz plik” i „Zapisz wszystkie pliki” w palecie poleceń; opcjonalny automatyczny zapis (`autoSave`: po chwili bez pisania albo po wyjściu z edytora).
- **Podgląd Markdown** ([#32](https://github.com/tarze07/Leverframe/issues/32)): dla plików `.md` tryby „tylko tekst”, „tekst i podgląd obok” (Ctrl+K V) i „tylko podgląd” (Ctrl+Shift+V). Podgląd odświeża się podczas pisania, pokazuje tabele, listy zadań, kod z kolorowaniem i obrazki z dysku; linki do stron otwierają się w przeglądarce, linki do plików – w edytorze. HTML z pliku jest oczyszczany (bez skryptów).

### Poprawione
- Przełączanie zakładek między plikami w edytorze: tekst nie trafia już do ukrytego, poprzednio edytowanego pliku, gdy fokus nie przeszedł na nowy plik (np. po otwarciu pliku z drzewa).

### Zmienione
- Nieudane wykrywanie agentów (np. host SSH nie odpowiada) nie jest już ponawiane przy każdym powrocie do panelu „Agenci” ani do profilu – ponownie tylko po kliknięciu „Sprawdź ponownie” ([#29](https://github.com/tarze07/Leverframe/issues/29)).

## [0.3.0] – 2026-11-09

Wybór folderu, w którym startuje agent ([#26](https://github.com/tarze07/Leverframe/issues/26)).

### Dodane
- **Folder, w którym startuje agent** ([#26](https://github.com/tarze07/Leverframe/issues/26)):
  - lista ostatnio używanych folderów w panelu „Agenci” – szybkie przełączanie bez okna wyboru;
  - **SSH**: katalog na serwerze, osobno dla każdego profilu (np. `~/projekty/app`); przed uruchomieniem agenta wykonywane jest `cd`;
  - **WSL**: folder wybrany w oknie wyboru z dysku dystrybucji (`\\wsl.localhost\Ubuntu\…`) jest zamieniany na ścieżkę Linuksa.

## [0.2.0] – 2026-11-09

Układ okna i motywy ([#22](https://github.com/tarze07/Leverframe/issues/22)).

### Dodane
- **Panel terminala obok edytora**: panel może być pod edytorem albo po jego prawej stronie (przycisk w nagłówku panelu, ustawienia, paleta poleceń); terminale działają dalej po przeniesieniu.
- **Maksymalizacja**: panel terminala na cały obszar bez edytora (Ctrl+Shift+M lub przycisk w nagłówku panelu) i edytor na cały obszar bez terminala (przycisk na pasku zakładek edytora); ponowne kliknięcie przywraca układ.
- **Odcienie motywów**: ciemne Północ, Grafit, Las, Śliwka, Wysoki kontrast i jasne Papier, Błękit, Mięta, Mgła, obok dotychczasowych. Motyw zmienia kolory interfejsu, terminala i edytora. W trybie „Jak w systemie” można wybrać, który motyw ciemny i który jasny ma być używany (`darkTheme`, `lightTheme` w `settings.json`).

### Poprawione
- Znaki wpisane w nowy terminal, zanim jego proces zdążył wystartować, nie giną – są wysyłane, gdy terminal ruszy.

## [0.1.0] – 2026-11-08

Pierwsza pełna wersja: wszystkie etapy [planu projektu](https://github.com/tarze07/Leverframe/blob/main/docs/PLAN.md).

### Dodane
- **Panel „Agenci”**: Claude Code, Codex, Agy i Kilo Code. Dla wybranego profilu terminala (lokalny, WSL, SSH, PowerShell) aplikacja sprawdza, czy agent jest zainstalowany i w jakiej wersji, i uruchamia go jednym kliknięciem w nowym terminalu.
- **Folder projektu**: katalog roboczy dla agentów (lokalnie i w WSL).
- **Definicje agentów w pliku `agents.json`**: można zmieniać wbudowanych agentów i dodawać własnych.
- **Podpowiedzi instalacji**: oficjalne komendy do skopiowania; aplikacja niczego nie instaluje sama.
- **Bezpieczne uruchamianie**: komenda agenta jest wpisywana dopiero, gdy powłoka jest gotowa, i nigdy w odpowiedzi na pytanie o hasło (np. przy logowaniu SSH).
- **Nagrywanie sesji agentów** (asciicast v2) z metadanymi (agent, profil, folder, czas, kod wyjścia) w bazie SQLite. Nagrywanie można wyłączyć, a historię wyczyścić.
- **Panel „Sesje”**: lista nagranych sesji, wyszukiwanie pełnotekstowe w wyjściu (także bez polskich znaków), filtry: agent, profil, projekt, data.
- **Odtwarzacz nagrań**: odtwarzanie i pauza, przewijanie, prędkość 0,5–8×, pomijanie przerw, wyszukiwanie w nagraniu.
- **Rozmowy agentów**: odczyt własnych logów Claude Code (`~/.claude/projects`) i Codex (`~/.codex/sessions`, także starszy format) – lokalnie i z dystrybucji WSL; lista odświeża się sama po zmianie plików.
- **Oś czasu rozmowy**: wiadomości, polecenia z wynikiem i kodem wyjścia, zmienione pliki, opcjonalnie rozumowanie; akcje: kopiuj polecenie, wpisz je w nowym terminalu (bez uruchamiania), wznów sesję (`claude --resume`, `codex resume`).
- **Edytor plików (Monaco)** w zakładkach obok terminali: podświetlanie składni, wyszukiwanie (Ctrl+F), zapis (Ctrl+S), znacznik niezapisanych zmian, pytanie o zapis przy zamykaniu, wykrywanie zmian pliku na dysku (nadpisz / wczytaj ponownie). Edytor ładuje się dopiero przy pierwszym otwarciu pliku.
- **Panel „Pliki”**: drzewo folderu projektu z pominięciem plików z `.gitignore`.
- **Szybkie otwieranie (Ctrl+P)** z dopasowaniem rozmytym; pliki z WSL przez `\\wsl.localhost`.
- **„Otwórz w edytorze”** dla plików zmienionych przez agenta (oś czasu rozmowy).
- **Ustawienia w `settings.json`**: motyw, czcionka, skróty klawiszowe; plik można edytować w edytorze aplikacji (zmiany działają po zapisaniu). Błąd składni w pliku jest pokazywany z numerem wiersza i nie zostanie nadpisany.
- **Jasny motyw** (także „jak w systemie”) – w interfejsie, terminalach, edytorze i odtwarzaczu.
- **Paleta poleceń (Ctrl+Shift+P)** z poleceniami terminali, profili, agentów, sesji, plików i ustawień.
- **Konfigurowalne skróty klawiszowe** (`keybindings` w `settings.json`), działające na każdym układzie klawiatury.
- **Rozmowy agentów z hostów SSH** (Claude Code, Codex), odświeżane na żądanie; wznawianie sesji na hoście.
- **Instalatory**: Windows `.exe` i `.msi`, Linux `.deb`, `.rpm` i `.AppImage`.
- **Wersja przenośna dla Windows** (`_x64-portable.zip`): rozpakuj i uruchom, bez instalatora i bez pakietu Visual C++ (biblioteka C wkompilowana w program).
- **Testy E2E** na prawdziwym oknie aplikacji w CI (Linux).

### Bezpieczeństwo
- Aplikacja nie przechowuje haseł ani kluczy: SSH korzysta z kluczy / agenta SSH systemu, agenci CLI trzymają swoje dane logowania sami. Nagrania sesji mogą zawierać to, co pojawiło się w terminalu – nagrywanie można wyłączyć, a historię wyczyścić.

### Znane ograniczenia
- Instalatory nie są podpisane cyfrowo (ostrzeżenie Windows SmartScreen: „Więcej informacji” → „Uruchom mimo to”).
- Brak wersji na macOS i automatycznych aktualizacji.
- Agy i Kilo Code: brak osi czasu z ich własnych logów (format nieudokumentowany) – ich sesje są dostępne jako nagrania.
- Logi z hostów SSH wymagają logowania kluczem (bez hasła).

## [0.1.0-alpha.1] – 2026-11-06

Pierwsza wersja testowa (alfa). Obejmuje etapy 0–2 [planu projektu](https://github.com/tarze07/Leverframe/blob/main/docs/PLAN.md).

### Dodane
- **Okno w stylu VS Code / Zed:** pasek aktywności, zwijany panel boczny i dolny, zakładki z podziałem i przeciąganiem, pasek stanu, ciemny motyw. Układ jest zapamiętywany.
- **Terminal** (xterm.js + pseudoterminal w Rust): kolory, dopasowanie rozmiaru, wyszukiwanie (Ctrl+F), linki (Ctrl+klik), kopiowanie i wklejanie (Ctrl+Shift+C / V; na Windows także Ctrl+C / V).
- **Wiele terminali** w zakładkach i podziałach, w panelu dolnym i w obszarze edytora. Ctrl+` pokazuje/chowa terminal, Ctrl+Shift+` otwiera nowy.
- **Profile terminali**, wykrywane automatycznie:
  - lokalne powłoki (bash, zsh, …; na Windows cmd i Git Bash),
  - dystrybucje WSL,
  - PowerShell 7 i Windows PowerShell,
  - hosty z `~/.ssh/config`.
- **Panel „Terminale”:** lista uruchomionych terminali i profili, otwieranie w podziale, profil domyślny, dodawanie i edycja hostów SSH (hasła nie są zapisywane).
- **Ustawienia czcionki** terminala (rodzina, rozmiar).

### Znane ograniczenia
- Instalatory nie są podpisane cyfrowo. Windows SmartScreen pokaże ostrzeżenie: wybierz „Więcej informacji” → „Uruchom mimo to”.
- Na Windows dostępny jest tylko instalator `.exe`, a na Linuksie `.deb` i `.AppImage` (AppImage działa także na Fedorze i innych dystrybucjach z RPM). Paczki `.msi` i `.rpm` pojawią się w wersji 0.1.0, bo nie obsługują numerów wersji typu „alpha”.
- Brak wersji na macOS.
- Panele „Agenci”, „Sesje” i „Pliki” są jeszcze puste (etapy 3–6).
- Brak automatycznych aktualizacji.

[0.14.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.14.1
[0.14.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.14.0
[0.13.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.13.0
[0.12.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.12.0
[0.11.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.11.0
[0.10.2]: https://github.com/tarze07/Leverframe/releases/tag/v0.10.2
[0.10.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.10.1
[0.10.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.10.0
[0.9.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.9.0
[0.8.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.8.1
[0.8.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.8.0
[0.7.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.7.1
[0.7.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.7.0
[0.6.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.6.0
[0.5.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.5.0
[0.4.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.4.0
[0.3.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.3.0
[0.2.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.2.0
[0.1.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.1.0
[0.1.0-alpha.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.1.0-alpha.1
