# Zmiany

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), numeracja zgodna z [SemVer](https://semver.org/lang/pl/).

## [Niewydane]

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

[0.1.0-alpha.1]: https://github.com/tarze07/Leverframe/releases/tag/v0.1.0-alpha.1
