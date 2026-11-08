# Leverframe — plan prostego terminala z edytorem

> Realizacja zadania [tarze07/Leverframe#1](https://github.com/tarze07/Leverframe/issues/1) („Edytor”).

## 1. Cel

Lekka aplikacja desktopowa łącząca:

- **terminal** z wieloma typami połączeń: **Linux shell**, **WSL**, **SSH**, **PowerShell**,
- **okno (panel) z listą dostępnych terminali** – profile wykrywane automatycznie i definiowane ręcznie,
- **szybkie uruchamianie agentów CLI**: **Claude Code**, **Codex**, **Agy** (Antigravity CLI), **Kilo Code**,
- **przeglądarkę sesji** – okno, w którym można zajrzeć do historii poleceń / rozmów wykonanych w tych narzędziach,
- **prosty edytor plików**,
- wygląd w stylu **Zed / Visual Studio Code** (ciemny motyw, activity bar, panele dzielone, zakładki, paleta poleceń).

Poza zakresem pierwszej wersji: debugger, LSP, system rozszerzeń, git UI.

## 2. Proponowane technologie

### Rekomendacja: Tauri 2 + Rust + React/TypeScript

| Warstwa | Technologia | Uzasadnienie |
|---|---|---|
| Powłoka aplikacji | **Tauri 2** | Małe binarki (~10 MB vs ~150 MB Electron), niskie zużycie RAM, natywne okna na Windows / Linux / macOS. |
| Backend | **Rust** (`tokio`) | Bezpieczna obsługa procesów, PTY, plików i SSH. |
| PTY | **`portable-pty`** (z projektu WezTerm) | Jedno API: ConPTY na Windows, `openpty` na Linux/macOS. |
| SSH | systemowy `ssh` uruchamiany w PTY (MVP), później opcjonalnie **`russh`** | Systemowy klient od razu obsługuje `~/.ssh/config`, agenta kluczy, ProxyJump. `russh` daje pełną kontrolę (np. SFTP do odczytu zdalnych sesji). |
| Frontend | **React 19 + TypeScript + Vite** | Popularny, szybki w rozwoju; alternatywnie SolidJS dla jeszcze mniejszego narzutu. |
| Emulator terminala | **xterm.js** + addony `fit`, `webgl`, `search`, `web-links`, `unicode11` | Ten sam silnik co terminal w VS Code – dojrzały, szybki (renderer WebGL). |
| Edytor | **Monaco Editor** (wygląd 1:1 z VS Code) lub **CodeMirror 6** (lżejszy, bliżej Zed) | Rekomendacja: Monaco na start – gotowe podświetlanie, minimapa, multi-cursor. |
| Układ paneli | **dockview** lub **react-resizable-panels** | Dzielenie widoków, przeciąganie zakładek, zapisywanie layoutu. |
| Stan UI | **Zustand** | Prosty, bez boilerplate'u. |
| Style / ikony | **Tailwind CSS** + **codicons** (`@vscode/codicons`) | Spójny wygląd z VS Code; motyw oparty o zmienne CSS (dark / light). |
| Paleta poleceń | **cmdk** | Ctrl+Shift+P / Ctrl+P jak w VS Code / Zed. |
| Dane lokalne | **SQLite** (`rusqlite`) + **FTS5** | Indeks sesji i pełnotekstowe wyszukiwanie. |
| Konfiguracja | plik `settings.json` / `profiles.json` (serde) | Edytowalny w samym edytorze aplikacji. |
| Obserwacja plików | **`notify`** (Rust) | Odświeżanie listy sesji na żywo. |
| Testy | `cargo test`, **Vitest**, **Playwright** (E2E) | |
| CI / wydania | GitHub Actions + `tauri-action` | Build `.msi`/`.exe`, `.AppImage`/`.deb`, `.dmg`. |

### Alternatywy (rozważone)

- **Electron + node-pty + xterm.js + Monaco** – dokładnie stos VS Code; najprostsza droga, ale cięższa aplikacja. Dobry wybór, jeśli zespół nie zna Rusta.
- **Rust natywnie (GPUI z Zed / egui / iced)** – najwyższa wydajność i „prawdziwy” wygląd Zed, ale brak gotowego edytora i emulatora terminala klasy xterm.js/Monaco → znacznie dłuższy czas realizacji.

## 3. Architektura

```
┌──────────────────────────── Frontend (WebView: React + TS) ────────────────────────────┐
│ ActivityBar │ SideBar: [Terminale] [Agenci] [Sesje] [Pliki] │ Editor/Terminal area │
│             │                                               │ (zakładki, split)    │
│                                  StatusBar / Command Palette                          │
└───────────────────────────────▲──────────────────────┬─────────────────────────────────┘
                     Tauri events (dane PTY)     Tauri commands (invoke)
┌───────────────────────────────┴──────────────────────▼─────────────────────────────────┐
│                                   Backend (Rust)                                        │
│  ProfileService   – wykrywanie i konfiguracja profili terminali                         │
│  PtyManager       – tworzenie/zamykanie PTY, resize, I/O, nagrywanie (asciicast)        │
│  AgentLauncher    – wykrywanie CLI agentów i uruchamianie ich w wybranym profilu        │
│  SessionService   – adaptery logów agentów + indeks SQLite/FTS5 + watcher plików        │
│  FsService        – odczyt/zapis plików dla edytora, drzewo katalogów                   │
│  SettingsService  – settings.json, profiles.json, layout                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Komunikacja:
- `invoke("pty_spawn", { request: { program, args, cwd, cols, rows }, onData, onExit })` → `{ id, program, pid }`
- `invoke("pty_write", { ptyId, data })`, `invoke("pty_resize", { ptyId, cols, rows })`, `invoke("pty_kill", { ptyId })`
- kanały Tauri (`Channel`) przekazywane w `pty_spawn`: `onData` – surowe bajty (ArrayBuffer, bez JSON/base64), buforowane co ~8 ms, aby nie zalewać WebView; `onExit` – kod wyjścia, wysyłany po dostarczeniu całego wyjścia. Kanały gwarantują kolejność wiadomości, w przeciwieństwie do zdarzeń globalnych.

## 4. Typy terminali (profile)

Model profilu:

```jsonc
{
  "id": "wsl-ubuntu",
  "name": "Ubuntu (WSL)",
  "kind": "wsl",            // "local" | "wsl" | "ssh" | "powershell"
  "command": "wsl.exe",
  "args": ["-d", "Ubuntu", "--cd", "~"],
  "env": {},
  "cwd": null,
  "icon": "terminal-ubuntu"
}
```

| Rodzaj | Wykrywanie | Uruchomienie |
|---|---|---|
| **Linux / macOS shell** | `$SHELL`, `/etc/shells` (bash, zsh, fish) | `$SHELL -l` w PTY |
| **WSL** (tylko Windows) | `wsl.exe -l -q` (uwaga: wyjście w UTF-16LE) lub rejestr `HKCU\...\Lxss` | `wsl.exe -d <dystrybucja> --cd ~` przez ConPTY |
| **PowerShell** | `pwsh.exe` (PowerShell 7) w `PATH`, `powershell.exe` (5.1); na Linux `pwsh`, jeśli zainstalowany | `pwsh -NoLogo` |
| **SSH** | hosty z `~/.ssh/config` (parser `Host`), plus ręcznie dodane | `ssh [-p port] [-i klucz] user@host` w PTY |
| (opcjonalnie) cmd, Git Bash | `cmd.exe`, `C:\Program Files\Git\bin\bash.exe` | |

**Panel „Terminale”** (sidebar):
- drzewo pogrupowane: *Lokalne*, *WSL*, *SSH*, *PowerShell*,
- akcje: ▶ otwórz w nowej zakładce, ⇥ otwórz w podziale, ✎ edytuj, ＋ dodaj profil (formularz SSH: host, port, użytkownik, klucz),
- sekcja *Uruchomione* – lista aktywnych PTY (nazwa, profil, czas, status) z możliwością przełączenia / zamknięcia,
- profil domyślny ustawiany w `settings.json`.

## 5. Agenci CLI

Wbudowana lista agentów (rozszerzalna w `settings.json`):

| Agent | Komenda | Wykrywanie wersji |
|---|---|---|
| Claude Code | `claude` | `claude --version` |
| Codex | `codex` | `codex --version` |
| Agy (Antigravity CLI) | `agy` | `agy --version` |
| Kilo Code CLI | `kilocode` | `kilocode --version` |

Nazwy komend i flagi należy zweryfikować z aktualną dokumentacją narzędzi i trzymać w konfiguracji, a nie w kodzie, bo zmieniają się między wersjami.

Działanie:
- **Panel „Agenci”** – kafelki z ikoną, statusem (zainstalowany / brak / wersja) i przyciskiem *Uruchom*.
- Uruchomienie = nowy PTY w **wybranym profilu** (np. Claude w WSL Ubuntu, Codex na serwerze SSH), z `cwd` = bieżący katalog projektu, następnie wpisanie komendy agenta. Dzięki temu agent działa w natywnym środowisku (PATH, klucze API, konfiguracja użytkownika).
- Wykrywanie dostępności per profil: `command -v claude` (sh) / `Get-Command claude` (PowerShell) uruchamiane jednorazowo w tle, wynik cache'owany.
- Opcjonalnie: przycisk „Zainstaluj” wyświetlający oficjalną komendę instalacyjną (bez automatycznego wykonywania).
- Skróty: paleta poleceń → „Agent: Uruchom Claude w …”.

## 6. Przeglądarka sesji

Okno/panel, w którym widać historię pracy agentów. Dwa uzupełniające się źródła danych:

### 6.1 Nagrywanie własne (działa dla każdego narzędzia)
Każda sesja PTY uruchomiona jako „agent” jest zapisywana w formacie **asciicast v2** (`<katalog danych aplikacji>/recordings/*.cast`, np. `~/.local/share/io.github.tarze07.leverframe/` na Linuksie, `%APPDATA%\io.github.tarze07.leverframe\` na Windows) + metadane w SQLite `sessions.db` (agent, profil, cwd, start/koniec, kod wyjścia). Pozwala to:
- odtworzyć sesję (odtwarzacz na bazie xterm.js, przewijanie w czasie),
- przeszukiwać tekst wyjścia (po usunięciu sekwencji ANSI, indeks FTS5).

### 6.2 Adaptery natywnych logów agentów
Agenci przechowują własną historię; adapter czyta ją i normalizuje do wspólnego modelu:

```ts
interface AgentSession {
  id: string; agent: "claude" | "codex" | "agy" | "kilo";
  profileId: string; cwd: string; startedAt: string; updatedAt: string;
  title?: string; entries: SessionEntry[];
}
type SessionEntry =
  | { type: "user"; text: string; ts: string }
  | { type: "assistant"; text: string; ts: string }
  | { type: "tool_call"; tool: string; input: unknown; ts: string }   // np. Bash: "npm test"
  | { type: "tool_result"; output: string; isError?: boolean; ts: string };
```

| Agent | Lokalizacja logów (do weryfikacji przy implementacji) | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<zakodowana-ścieżka>/<session-id>.jsonl` | JSONL |
| Codex | `~/.codex/sessions/RRRR/MM/DD/rollout-*.jsonl` | JSONL |
| Agy | nieudokumentowany – brak adaptera, dostępne nagrania z 6.1 | – |
| Kilo Code CLI | nieudokumentowany – brak adaptera, dostępne nagrania z 6.1 | – |

Formaty logów nie są publicznym, stabilnym API, więc każdy adapter jest osobnym modułem z testami na próbkach plików i tolerancyjnym parserem (nieznane pola ignorowane). Jeśli adaptera brak lub parsowanie się nie uda, zostaje nagranie z 6.1.

Dostęp do logów zależnie od profilu:
- **lokalny** – bezpośrednio z dysku + watcher `notify`,
- **WSL** – przez ścieżkę `\\wsl.localhost\<distro>\home\<user>\...`,
- **SSH** – przez SFTP (`russh-sftp`) lub `ssh host cat …`, odświeżanie na żądanie.

### 6.3 UI przeglądarki sesji
- lista sesji (filtry: agent, profil, projekt/cwd, data; wyszukiwanie pełnotekstowe),
- widok szczegółów w formie osi czasu: wiadomości użytkownika, odpowiedzi, **wywołane polecenia** (wyróżnione, z wynikiem i kodem wyjścia), zmienione pliki,
- akcje: *Kopiuj polecenie*, *Uruchom ponownie w terminalu*, *Otwórz plik w edytorze*, *Wznów sesję* (np. `claude --resume <id>`, `codex resume <id>` – jeśli narzędzie to wspiera).

## 7. Edytor

- Monaco w zakładkach obok terminali (wspólny system zakładek i podziałów),
- drzewo plików (panel „Pliki”) dla otwartego folderu,
- zapis Ctrl+S, wskaźnik niezapisanych zmian, podświetlanie składni, wyszukiwanie w pliku,
- Ctrl+P – szybkie otwieranie pliku (fuzzy search, `ignore`/`.gitignore` po stronie Rust),
- na start tylko pliki lokalne; pliki WSL przez `\\wsl.localhost`, zdalne (SSH/SFTP) w późniejszym etapie.

## 8. Wygląd (styl Zed / VS Code)

```
┌──┬──────────────────┬──────────────────────────────────────────────┐
│▣ │ TERMINALE        │ [main.rs] [bash ✕] [claude · wsl ✕]          │
│⌨ │ ▾ Lokalne        │──────────────────────────────────────────────│
│🤖│   bash           │                                              │
│🕘│ ▾ WSL            │        edytor / terminal (split H/V)          │
│📁│   Ubuntu         │                                              │
│  │ ▾ SSH            │                                              │
│  │   prod-server    │──────────────────────────────────────────────│
│⚙ │ ▾ PowerShell     │  panel dolny: terminal                       │
├──┴──────────────────┴──────────────────────────────────────────────┤
│ ⎇ profil: Ubuntu (WSL) · agent: claude · UTF-8 · Ln 12, Col 4      │
└────────────────────────────────────────────────────────────────────┘
```

- Activity bar (ikony codicons): Terminale, Agenci, Sesje, Pliki, Ustawienia,
- zwijany sidebar, zakładki z przeciąganiem, podział poziomy/pionowy, panel dolny,
- paleta poleceń (Ctrl+Shift+P), szybkie otwieranie (Ctrl+P), przełączanie terminali (Ctrl+`),
- motyw ciemny domyślnie (paleta zbliżona do „One Dark” / „Dark Modern”), jasny opcjonalnie; czcionka mono konfigurowalna (np. JetBrains Mono),
- bezramkowe okno z własnym paskiem tytułu (Tauri `decorations: false`), zapamiętywanie układu.

## 9. Struktura repozytorium

```
leverframe/
├─ src-tauri/                 # backend Rust
│  ├─ src/
│  │  ├─ main.rs
│  │  ├─ pty/                 # PtyManager, nagrywanie asciicast
│  │  ├─ profiles/            # wykrywanie: local, wsl, ssh_config, powershell
│  │  ├─ agents/              # definicje i wykrywanie agentów
│  │  ├─ sessions/            # SessionService + adapters/{claude,codex,agy,kilo}.rs
│  │  ├─ fs/                  # FsService
│  │  └─ settings/
│  └─ tauri.conf.json
├─ src/                       # frontend React + TS
│  ├─ components/{ActivityBar,SideBar,Tabs,StatusBar,CommandPalette}/
│  ├─ features/{terminal,editor,profiles,agents,sessions,files}/
│  ├─ store/                  # Zustand
│  └─ theme/
├─ docs/PLAN.md
└─ .github/workflows/         # CI + release
```

## 10. Etapy realizacji

| Etap | Zakres | Kryterium ukończenia |
|---|---|---|
| **0. Szkielet** | Tauri 2 + React + Vite, layout (activity bar, sidebar, zakładki, status bar), motyw, CI | Aplikacja buduje się na Windows i Linux w CI |
| **1. Terminal lokalny** | `portable-pty`, xterm.js (WebGL), wiele zakładek, resize, split | Działający bash/zsh na Linux i PowerShell na Windows |
| **2. Profile** | Wykrywanie WSL, PowerShell, hostów z `~/.ssh/config`; panel „Terminale”; formularz SSH; `profiles.json` | Można otworzyć terminal z każdego z 4 typów |
| **3. Agenci** | Panel „Agenci”, wykrywanie per profil, uruchamianie w wybranym profilu i cwd | Claude/Codex/Agy/Kilo uruchamiane jednym kliknięciem |
| **4. Sesje – nagrywanie** | asciicast + SQLite + odtwarzacz + FTS5 | Każda sesja agenta do odtworzenia i przeszukania |
| **5. Sesje – adaptery** | Adaptery Claude i Codex (lokalnie + WSL), potem Agy i Kilo; widok osi czasu; „Wznów sesję” | Lista poleceń wykonanych przez agenta widoczna w panelu |
| **6. Edytor** | Monaco, drzewo plików, Ctrl+P, zapis | Edycja plików projektu obok terminala |
| **7. Szlif** | Paleta poleceń, skróty, ustawienia w JSON, jasny motyw, sesje przez SSH/SFTP, instalatory | Wydanie 0.1.0 |

## 11. Ryzyka i decyzje do podjęcia

- **Zmienne formaty logów agentów** – adaptery izolowane, testy na próbkach, fallback do nagrywania.
- **ConPTY na Windows** – wymaga Windows 10 1809+; kodowanie wyjścia `wsl.exe -l` (UTF-16LE).
- **Wydajność strumienia PTY → WebView** – buforowanie i wysyłanie paczkami, renderer WebGL.
- **Bezpieczeństwo** – brak przechowywania haseł SSH w plikach (tylko agent kluczy / systemowy keychain przez `keyring`), nagrania sesji mogą zawierać sekrety → opcja wyłączenia nagrywania i czyszczenia historii.
- **Do decyzji**: Monaco vs CodeMirror 6; czy macOS jest platformą docelową; czy SSH od razu przez `russh`, czy na start systemowy `ssh`.
