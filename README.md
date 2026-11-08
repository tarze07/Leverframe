# Leverframe

Prosty terminal z edytorem (styl Zed / VS Code) obsługujący Linux shell, WSL, SSH i PowerShell,
z szybkim uruchamianiem agentów CLI (Claude Code, Codex, Agy, Kilo Code) i przeglądarką ich sesji.

Plan projektu i propozycja technologii: [docs/PLAN.md](docs/PLAN.md). Historia zmian: [CHANGELOG.md](CHANGELOG.md).

## Instalacja

Instalatory są w zakładce [Releases](https://github.com/tarze07/Leverframe/releases):

| System | Plik |
|---|---|
| Windows 10/11 | `Leverframe_<wersja>_x64-setup.exe` lub `Leverframe_<wersja>_x64_en-US.msi` |
| Windows bez instalacji | `Leverframe_<wersja>_x64-portable.zip` – rozpakuj i uruchom `Leverframe.exe` |
| Debian / Ubuntu | `Leverframe_<wersja>_amd64.deb` (`sudo apt install ./plik.deb`) |
| Fedora / openSUSE | `Leverframe-<wersja>-1.x86_64.rpm` (`sudo dnf install ./plik.rpm`) |
| Inne dystrybucje Linuksa | `Leverframe_<wersja>_amd64.AppImage` (`chmod +x`, potem uruchom) |

Wersja przenośna (ZIP) niczego nie instaluje – wymaga tylko WebView2, które jest w Windows 11 i aktualnych Windows 10; szczegóły w pliku `CZYTAJ-MNIE.txt` w archiwum. Ustawienia trzyma w profilu użytkownika, więc wersja przenośna i instalowana dzielą je ze sobą.

Instalatory nie są podpisane cyfrowo. Na Windows SmartScreen pokaże ostrzeżenie: wybierz **Więcej informacji → Uruchom mimo to**.

## Skróty klawiszowe

| Skrót | Działanie |
|---|---|
| Ctrl+Shift+P | Paleta poleceń |
| Ctrl+P | Szybkie otwieranie pliku |
| Ctrl+` / Ctrl+Shift+` | Pokaż/ukryj terminal / nowy terminal |
| Ctrl+B / Ctrl+J | Panel boczny / panel dolny |
| Ctrl+Shift+E | Panel „Pliki” |
| Ctrl+S, Ctrl+F | Zapis i wyszukiwanie w edytorze |
| Ctrl+F, Ctrl+Shift+C / V | Wyszukiwanie, kopiowanie i wklejanie w terminalu |

## Ustawienia

Plik `settings.json` (paleta poleceń → „Otwórz settings.json”) – zmiany działają po zapisaniu:

```json
{
  "theme": "system",
  "fontFamily": "JetBrains Mono, monospace",
  "fontSize": 14,
  "keybindings": { "palette.open": "Ctrl+K", "view.files": null },
  "recordSessions": true
}
```

`theme`: `dark` / `light` / `system`. W `keybindings` identyfikatory poleceń (np. `palette.open`, `files.quickOpen`, `terminal.new`, `view.toggleSidebar`) przypisuje się do skrótów; `null` wyłącza skrót domyślny. Własnych agentów CLI dodaje się w `agents.json` w tym samym folderze.

## Bezpieczeństwo

Leverframe nie zapisuje haseł ani kluczy, więc nie korzysta z systemowego pęku kluczy: połączenia SSH używają kluczy i agenta SSH systemu (hasło wpisuje się w terminalu), a agenci CLI przechowują swoje dane logowania sami. Nagrania sesji agentów zawierają wszystko, co pojawiło się w terminalu – nagrywanie można wyłączyć w panelu „Sesje” lub w `settings.json`.

## Stos

Tauri 2 (Rust) · React 19 + TypeScript · Vite · Tailwind CSS 4 · dockview · react-resizable-panels · Zustand · codicons

## Wymagania

- Node.js 22+ i npm
- Rust (stable) – <https://rustup.rs>
- Zależności systemowe Tauri – <https://v2.tauri.app/start/prerequisites/>
  - Linux (Debian/Ubuntu): `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`
  - Windows: WebView2 (wbudowany w Windows 10/11) i Microsoft C++ Build Tools

## Uruchomienie

```bash
npm install
```

```bash
npm run tauri dev
```

Sam interfejs (bez backendu Rust) w przeglądarce: `npm run dev`, potem <http://localhost:1420>.

## Komendy

| Komenda | Opis |
|---|---|
| `npm run tauri dev` | Aplikacja w trybie deweloperskim |
| `npm run tauri build` | Build produkcyjny z instalatorami |
| `npm run lint` | ESLint |
| `npm run typecheck` | Sprawdzenie typów TypeScript |
| `npm test` | Testy frontendu (Vitest) |
| `npm run e2e` | Testy E2E na prawdziwym oknie aplikacji (Linux, wymaga `tauri-driver`, `WebKitWebDriver` i Xvfb) |
| `cargo test` (w `src-tauri/`) | Testy backendu |

## Wydanie nowej wersji

1. Ustaw tę samą wersję w `package.json`, `src-tauri/Cargo.toml` i `src-tauri/tauri.conf.json` (sprawdza to `node scripts/check-version.mjs`, także w CI).
2. Dopisz sekcję `## [wersja]` w `CHANGELOG.md` – jej treść trafi do opisu wydania.
3. Po scaleniu do `main` utwórz i wypchnij tag `v<wersja>`:

   ```bash
   git tag v0.1.0-alpha.1 && git push origin v0.1.0-alpha.1
   ```

Workflow `.github/workflows/release.yml` zbuduje instalatory na Windows i Linux i opublikuje wydanie. Wersje z sufiksem (`-alpha.1`, `-beta.2`) są oznaczane jako pre-release.

Aby ponownie zbudować i dograć instalatory do istniejącego wydania, uruchom workflow ręcznie: **Actions → Release → Run workflow** i podaj tag (np. `v0.1.0-alpha.1`). Istniejące wydanie zostanie użyte ponownie. Wydanie jest publikowane dopiero wtedy, gdy ma wszystkie instalatory (`.exe`, `.deb`, `.AppImage`).

## Struktura

```
src/                 frontend (React)
  components/        układ: TitleBar, ActivityBar, SideBar, Workbench, BottomPanel, StatusBar
  features/          widoki funkcji: profiles, agents, sessions, files, editor, settings
  store/             stan UI (Zustand)
  theme/             tokeny kolorów i style
src-tauri/           backend (Rust): settings, pty, profiles, agents, sessions, fs
```
