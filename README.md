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
| Ctrl+B / Ctrl+J | Panel boczny / panel terminala |
| Ctrl+Shift+M | Maksymalizuj panel terminala (ukryj edytor) / przywróć |
| Ctrl+Shift+E | Panel „Pliki” |
| Ctrl+S, Ctrl+F | Zapis i wyszukiwanie w edytorze |
| Ctrl+Shift+V / Ctrl+K V | Podgląd Markdown / podgląd obok tekstu (w edytorze pliku `.md`) |
| Ctrl+F, Ctrl+Shift+C / V | Wyszukiwanie, kopiowanie i wklejanie w terminalu |

## Edytor

Nad każdym plikiem jest pasek z jego ścieżką, informacją o niezapisanych zmianach i przyciskiem **Zapisz** (albo Ctrl+S). Paleta poleceń ma też „Zapisz wszystkie pliki”. Automatyczny zapis włączysz w ustawieniach („Automatyczny zapis plików”) lub w `settings.json`: `"autoSave": "afterDelay"` (po sekundzie bez pisania) albo `"onFocusChange"` (po wyjściu z edytora). Jeśli plik zmienił się na dysku, aplikacja zapyta, czy go nadpisać.

Pliki Markdown (`.md`) mają trzy widoki, przełączane na pasku: sam tekst, tekst z podglądem obok i sam podgląd. Podgląd pokazuje obrazki z dysku (ścieżki względem pliku) i z internetu; linki do stron otwierają się w przeglądarce, a linki do innych plików – w edytorze.

## Agenci

Panel „Agenci” uruchamia agenta CLI w nowym terminalu wybranego profilu. Folder, w którym startuje, wybierasz nad listą agentów (ikona zegara pokazuje ostatnio używane foldery); ten sam folder jest korzeniem panelu „Pliki”. W profilach WSL można wskazać też folder z dysku dystrybucji (w oknie wyboru: Linux → dystrybucja). Dla profili SSH wpisuje się katalog na serwerze – osobno dla każdego hosta.

### Tryb rozmowy (ACP)

Agenci obsługujący [Agent Client Protocol](https://agentclientprotocol.com) mają obok przycisku **Terminal** przycisk **Rozmowa**: agent działa wtedy w tle, a rozmowa toczy się w panelu Leverframe (zgody na działania agenta w oknach aplikacji). Wymaga programu ACP w tym samym profilu:

| Agent | Program trybu rozmowy | Instalacja |
|---|---|---|
| Claude Code | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` (Node.js 22+) |
| Codex | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` |
| Gemini CLI | `gemini --acp` | `npm install -g @google/gemini-cli` (Node.js 20+) |

Panel „Agenci” pokazuje, czy program jest zainstalowany. Agent, który wymaga zalogowania, pokaże w panelu rozmowy swoje metody logowania (Codex: klucz API lub konto ChatGPT; Gemini: konto Google, klucz API, Vertex AI); zawsze można też zalogować się raz w trybie terminalowym – adapter Claude korzysta z logowania Claude Code (`claude`, polecenie `/login`). Leverframe nie przechowuje kluczy ani haseł.

Wskazówki:
- **Tryb Claude**: adapter Claude zaczyna w trybie *Auto* – sam decyduje, kiedy pytać. Żeby zatwierdzać każdą zmianę pliku i polecenie, wybierz nad polem wiadomości tryb *Manual* (albo *Plan*, żeby najpierw dostać plan).
- **Pliki i polecenia przez Leverframe** (niezapisane zmiany z edytorów, terminale Leverframe, pytanie przed poleceniem) działają z agentami, które korzystają z tych możliwości klienta ACP. Adapter Claude (`claude-agent-acp` 0.106) zmienia pliki i uruchamia polecenia własnymi narzędziami – zmiany widać w kartach narzędzi i jako diff w prośbie o zgodę. Otwarty edytor bez niezapisanych zmian wczytuje zmieniony plik od razu (jako jedną zmianę do cofnięcia), a w edytorze z niezapisanymi zmianami zapis pokaże konflikt z opcjami „Nadpisz” i „Wczytaj z dysku”.
- **WSL i SSH**: program trybu rozmowy (i Node.js) musi być zainstalowany po tamtej stronie – w dystrybucji WSL albo na hoście SSH – i tam też trzeba się zalogować. Na hostach SSH agent pracuje na swoich plikach i we własnym terminalu: Leverframe nie udostępnia mu plików z tego komputera ani terminali, a kliknięcie ścieżki nie otwiera pliku w edytorze. Połączenie SSH działa bez pytań (`BatchMode`), więc host musi przyjmować klucz z agenta SSH. W `agents.json` pole `acp` (`command`, `args`, `install`) dodaje lub zmienia tryb rozmowy, a `"acp": null` go wyłącza, np.:

```json
{ "agents": [{ "id": "kilo", "acp": { "command": "kilo", "args": ["acp"] } }] }
```

Panel rozmowy pokazuje odpowiedzi agenta jako Markdown (z rozwijanym rozumowaniem), jego plan, karty wywołań narzędzi (kliknięcie pliku otwiera go w edytorze na właściwej linii), prośby o zgodę oraz zużycie kontekstu. Pole wiadomości rośnie razem z tekstem; przycisk obok pola powiększa je na większość panelu, a uchwyt nad polem pozwala ustawić wysokość ręcznie (zapamiętywaną; dwuklik przywraca automatyczną). Wpisanie `/` pokazuje komendy agenta; tryb i opcje agenta (np. model) zmienia się nad polem wiadomości; **Stop** przerywa turę. Rozmowę można otworzyć w obszarze edytora (przycisk **Rozmowa**) albo w panelu terminala (paleta: „Rozmowa z … w panelu terminala”). Agent czyta i zapisuje pliki **przez Leverframe** (profile lokalne i WSL): widzi też niezapisane zmiany z otwartych edytorów, a jego zapis trafia do otwartego edytora jako jedna zmiana do cofnięcia (Ctrl+Z) i jest zapisywany z wykrywaniem konfliktów. Proponowane zmiany widać jako diff w prośbie o zgodę („Otwórz zmianę” pokazuje je obok siebie w obszarze edytora); opcje zgody wybiera się też klawiszami 1–9, a zakładka rozmowy czekającej na decyzję ma znacznik ⚑. Bez pytania agent ma dostęp tylko do folderu projektu (także po rozwinięciu `..` i dowiązań symbolicznych) – o plik spoza niego Leverframe pyta. Polecenia agenta (np. `npm test`) uruchamia Leverframe w terminalu tego samego profilu – po pytaniu: **Uruchom**, **Zawsze dla tego polecenia** (do końca rozmowy) albo **Odmów**. Pytanie można wyłączyć w ustawieniach („Pytaj przed poleceniami agentów”, `acpConfirmCommands` w `settings.json`). Wyjście polecenia widać na żywo w karcie narzędzia, a „Otwórz jako terminal” pokazuje je w pełnym rozmiarze w panelu terminala; agent dostaje czysty tekst (bez kodów kolorów), przycięty do zamówionego limitu. Zamknięcie rozmowy kończy polecenia agenta. Na hostach SSH agent korzysta z własnego dostępu do plików i własnego terminala ([docs/ACP.md](docs/ACP.md)).

Otwarte rozmowy są w widoku **Rozmowy** na pasku aktywności (ikona dymków): z agentem, tematem, folderem i stanem – *czeka na decyzję*, *pracuje*, *gotowy*, *zakończony*; liczba na ikonie mówi, ile rozmów czeka na decyzję. Kliknięcie przełącza na rozmowę (albo otwiera jej kartę ponownie) i pokazuje jej koniec – kliknięcie karty rozmowy też przewija na koniec. **Zamknięcie karty nie kończy rozmowy** – agent pracuje dalej w tle; rozmowę kończy przycisk *Zakończ* w widoku „Rozmowy” (przy pracującym agencie po potwierdzeniu), co zatrzymuje agenta i zamyka kartę.

Rozmowy trafiają do historii w panelu „Sesje” (zakładka **Historia**, obok nagrań terminala; filtr „Rodzaj”) i można je przeszukiwać po treści wiadomości, także bez polskich znaków („zolto” znajdzie „żółto”). Kliknięcie otwiera rozmowę tylko do odczytu; jeśli agent pozwala wczytywać zapisane sesje (`session/load` lub `session/resume`), przycisk **Wznów rozmowę** kontynuuje ją w tym samym panelu, a dalszy ciąg dopisuje się do tej samej pozycji historii. Agenci udostępniający listę swoich sesji (`session/list`) mają w nagłówku rozmowy przycisk **Rozmowy agenta** – można tam otworzyć np. sesję rozpoczętą w terminalu, a na wyraźne żądanie usunąć ją u agenta. Historia zapisuje wiadomości, narzędzia, skrócone diffy i wyjście poleceń (bez treści plików); nagrywanie wyłącza to samo ustawienie co nagrania terminala.

## Układ okna

Panel terminala może być pod edytorem albo obok niego (przycisk w nagłówku panelu, ustawienia lub paleta poleceń: „Przenieś panel terminala obok edytora”). Przycisk maksymalizacji w nagłówku panelu (Ctrl+Shift+M) ukrywa edytor, a ten sam przycisk na pasku zakładek edytora ukrywa terminal; ponowne kliknięcie przywraca układ. Przeciągnięcie separatora do końca działa tak samo. Uruchomione terminale działają dalej przy każdej zmianie układu.

## Ustawienia

Plik `settings.json` (paleta poleceń → „Otwórz settings.json”) – zmiany działają po zapisaniu:

```json
{
  "theme": "system",
  "darkTheme": "dark-midnight",
  "lightTheme": "light-paper",
  "fontFamily": "JetBrains Mono, monospace",
  "fontSize": 14,
  "keybindings": { "palette.open": "Ctrl+K", "view.files": null },
  "recordSessions": true
}
```

`theme`: identyfikator motywu albo `system` (wtedy motyw wybierają `darkTheme` i `lightTheme` według ustawień systemu). Motywy ciemne: `dark`, `dark-midnight` (Północ), `dark-graphite` (Grafit), `dark-forest` (Las), `dark-plum` (Śliwka), `dark-contrast` (Wysoki kontrast); jasne: `light`, `light-paper` (Papier), `light-sky` (Błękit), `light-mint` (Mięta), `light-mist` (Mgła). Motyw zmienia też kolory terminala i edytora; szybko wybierzesz go w palecie poleceń („Motyw: …”). W `keybindings` identyfikatory poleceń (np. `palette.open`, `files.quickOpen`, `terminal.new`, `view.toggleSidebar`) przypisuje się do skrótów; `null` wyłącza skrót domyślny. Własnych agentów CLI dodaje się w `agents.json` w tym samym folderze.

## Bezpieczeństwo

Leverframe nie zapisuje haseł ani kluczy, więc nie korzysta z systemowego pęku kluczy: połączenia SSH używają kluczy i agenta SSH systemu (hasło wpisuje się w terminalu), a agenci CLI przechowują swoje dane logowania sami. Nagrania sesji agentów zawierają wszystko, co pojawiło się w terminalu, a historia rozmów – to, co agent napisał i pokazał – nagrywanie można wyłączyć w panelu „Sesje” lub w `settings.json`.

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
   git tag v0.6.0 && git push origin v0.6.0
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
