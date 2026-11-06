# Zmiany

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), numeracja zgodna z [SemVer](https://semver.org/lang/pl/).

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
