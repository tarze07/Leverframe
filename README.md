# Leverframe

Prosty terminal z edytorem (styl Zed / VS Code) obsługujący Linux shell, WSL, SSH i PowerShell,
z szybkim uruchamianiem agentów CLI (Claude Code, Codex, Agy, Kilo Code) i przeglądarką ich sesji.

Plan projektu i propozycja technologii: [docs/PLAN.md](docs/PLAN.md).

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
| `cargo test` (w `src-tauri/`) | Testy backendu |

## Struktura

```
src/                 frontend (React)
  components/        układ: TitleBar, ActivityBar, SideBar, Workbench, BottomPanel, StatusBar
  features/          widoki funkcji: profiles, agents, sessions, files, editor, settings
  store/             stan UI (Zustand)
  theme/             tokeny kolorów i style
src-tauri/           backend (Rust): settings, pty, profiles, agents, sessions, fs
```
