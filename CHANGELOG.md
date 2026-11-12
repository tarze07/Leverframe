# Zmiany

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), numeracja zgodna z [SemVer](https://semver.org/lang/pl/).

## [Unreleased]

### Dodane
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

[0.5.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.5.0
[0.4.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.4.0
[0.3.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.3.0
[0.2.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.2.0
[0.1.0]: https://github.com/tarze07/Leverframe/releases/tag/v0.1.0
[0.1.0-alpha.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.1.0-alpha.1
