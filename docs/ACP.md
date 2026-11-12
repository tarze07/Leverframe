# Leverframe – propozycja: agenci przez Agent Client Protocol (ACP)

Dokument uzupełnia [PLAN.md](PLAN.md). Zadania: epik [#35](https://github.com/tarze07/Leverframe/issues/35), etapy A1–A7 to #36–#42.

## 1. Cel

Dziś Leverframe uruchamia agentów (Claude Code, Codex, Agy, Kilo Code) w terminalu: agent rysuje własny
interfejs tekstowy, a aplikacja tylko go wyświetla i nagrywa. **ACP** pozwala, żeby to Leverframe prowadził
rozmowę z agentem przez własny interfejs:

- panel rozmowy z odpowiedziami w Markdown, planem i wywołaniami narzędzi,
- zmiany w plikach jako **diff w edytorze** (akceptacja / odrzucenie),
- **zgody** („czy mogę uruchomić `npm test`?”) w oknach aplikacji zamiast pytań w terminalu,
- agent czyta pliki **z otwartych edytorów, także niezapisane zmiany**,
- historia rozmów w uporządkowanej postaci, z wyszukiwaniem.

Terminal zostaje: tryb ACP to druga droga uruchomienia, dla agentów, które go obsługują.

## 2. Czym jest ACP

[Agent Client Protocol](https://agentclientprotocol.com) to otwarty standard (zainicjowany przez Zed) komunikacji
**edytor ↔ agent programistyczny** – dla agentów to samo, co LSP dla języków.

- **Transport**: edytor (*klient*) uruchamia agenta jako podproces; JSON-RPC 2.0 przez stdin/stdout.
- **Wersje**: stabilne jest **ACP v1**; v2 to wciąż szkic (SDK oznacza go jako eksperymentalny,
  „może zmienić się niekompatybilnie”). **Celujemy w stabilne v1.**

Metody stabilnego v1 (z oficjalnego schematu `schema/v1/schema.json`, SDK `@agentclientprotocol/sdk` 2.6.0):

| Kierunek | Metody |
|---|---|
| klient → agent | `initialize`, `authenticate`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option`, `session/close`, `session/delete` |
| agent → klient | `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`, `elicitation/create` |
| powiadomienia | `session/update` (agent → klient), `elicitation/complete` |

`session/update` niesie m.in.: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `tool_call`,
`tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`,
`session_info_update`, `usage_update`.

Wywołanie narzędzia (`ToolCall`) ma rodzaj (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`,
`fetch`, …), status (`pending` → `in_progress` → `completed` / `failed`), lokalizacje (plik i linia) oraz treść:
tekst, **diff** (`path`, `oldText`, `newText`) albo **terminal**. Zgoda ma opcje `allow_once`, `allow_always`,
`reject_once`, `reject_always`. Tura kończy się powodem: `end_turn`, `max_tokens`, `max_turn_requests`,
`refusal`, `cancelled`.

Klient deklaruje w `initialize`, co udostępnia (`fs.readTextFile`, `fs.writeTextFile`, `terminal`); agent – co
obsługuje (`loadSession`, obrazy/kontekst w promptach, MCP, metody logowania).

## 3. Agenci w trybie ACP (stan na listopad 2026)

| Agent | Tryb ACP | Uwagi |
|---|---|---|
| Claude Code | adapter `claude-agent-acp` (npm `@agentclientprotocol/claude-agent-acp`) | wymaga Node.js; dawny `@zed-industries/claude-code-acp` jest przestarzały |
| Codex | adapter `codex-acp` (npm `@agentclientprotocol/codex-acp`) | dawny `@zed-industries/codex-acp` jest przestarzały |
| Gemini CLI | `gemini --acp` (starsze wersje: `--experimental-acp`) | nowy agent w katalogu |
| Kilo Code | **do sprawdzenia** | CLI oparte na opencode (`opencode acp`); flagi nie da się potwierdzić bez instalacji |
| Agy | **brak informacji** | zostaje w trybie terminalowym |

Komendy trzymamy w `agents.json` (nie w kodzie) – zmieniają się szybciej niż aplikacja.

## 4. Architektura

```
React UI ──invoke/Channel──▶ Rust: AcpService ──stdio (JSON-RPC)──▶ proces agenta (lokalnie / WSL / SSH)
   ▲  panel rozmowy, diffy,        │  sesje, routing session/update,
   │  zgody, edytory               │  obsługa fs/* i terminal/*
   └───────────── zdarzenia ◀──────┘
```

- **Backend (Rust)**: moduł `src-tauri/src/acp` – **własna, cienka warstwa JSON-RPC 2.0** (decyzja z A1, #36):
  - oficjalna biblioteka [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol) zmieniała wersję
    główną z 3.x na 5.x w ciągu dwóch tygodni; wersja starsza niż 2 tygodnie (nasza zasada dla zależności) to
    już 3.4.0, dwie wersje główne wstecz;
  - wymaga runtime’u async, a backend Leverframe działa na wątkach (PTY, nagrywanie, logi);
  - potrzebny fragment protokołu jest mały; typy przekazujemy do UI jako JSON, więc nowe pola i warianty
    `session/update` nie wymagają zmian w Rust.

  Pliki: `rpc.rs` (JSON-RPC na strumieniu, wiadomość = linia), `launch.rs` (uruchamianie wg profilu),
  `session.rs` (handshake, prompt, zgody, logowanie, zdarzenia `AcpEvent`), `commands.rs` (komendy Tauri).
  Atrapa agenta do testów: `src-tauri/examples/fake_acp_agent.rs`.
- **Uruchamianie zależne od profilu**, bez PTY (czyste potoki stdin/stdout):
  - lokalnie / PowerShell: bezpośrednio,
  - WSL: `wsl.exe -d <dystrybucja> --cd <katalog> -- <komenda>`,
  - SSH: `ssh -T <host> 'cd <katalog> && <komenda>'` (katalog z ustawień profilu, #26).
- **Frontend**: nowy panel dockview `agentChat`; stan sesji w osobnym store; strumień zdarzeń przez `Channel`
  (jak wyjście terminala).
- **Ścieżki**: agent widzi ścieżki swojego systemu. WSL: `/home/…` ↔ `\\wsl.localhost\<dystrybucja>\home\…`
  (już mamy obie strony tej zamiany). SSH: plików zdalnych nie mamy lokalnie – w sesjach SSH **nie deklarujemy**
  `fs` ani `terminal`, agent korzysta z własnych.

## 5. Bezpieczeństwo

- Agent może poprosić o **dowolny** plik. Leverframe pozwala bez pytania tylko w folderze sesji (`cwd`); poza nim –
  zgoda użytkownika. Sprawdzenie robi backend (`src-tauri/src/acp/fs.rs`) po przetłumaczeniu ścieżki agenta
  (WSL: `/home/…` → `\\wsl.localhost\<dystrybucja>\…`, `/mnt/c/…` → `C:\…`), rozwinięciu `..` i dowiązań
  symbolicznych (także części ścieżki, która jeszcze nie istnieje); UI dostaje gotową flagę `inside`.
- `fs/write_text_file` idzie przez istniejący zapis z wykrywaniem konfliktów; otwarty edytor dostaje nową treść
  (z cofaniem, Ctrl+Z).
- `terminal/create`: o zgodę na polecenie agent pyta sam (`session/request_permission`), ale klient nie może
  sprawdzić, że zapytał. Dlatego Leverframe sam pyta przed uruchomieniem polecenia (ustawienie, domyślnie
  włączone; odpowiedź „zawsze dla tego polecenia” obowiązuje do końca sesji). Wyjście jest przycinane do limitu
  bajtów z żądania.
- Treść od agenta (Markdown) przechodzi przez to samo czyszczenie co podgląd (#32). Linki nie przełączają okna.
- Historia rozmów (A6) zapisuje to, co widział panel: wiadomości, karty narzędzi, diffy skrócone do 4000 znaków
  na tekst, wyjście poleceń do 32 KB na polecenie; **bez** treści plików, które agent zapisuje, i bez logu agenta.
  Nagrywanie wyłącza to samo ustawienie co nagrania terminala (`recordSessions`).
- Leverframe nadal nie przechowuje kluczy: logowanie (`authenticate`) obsługuje agent; aplikacja tylko pokazuje
  metody logowania, które agent zgłasza.

## 6. Etapy

| Etap | Zakres | Wynik |
|---|---|---|
| **A1** ([#36](https://github.com/tarze07/Leverframe/issues/36)) | Klient ACP w Rust: uruchamianie wg profilu, `initialize`, `session/new`, `session/prompt`, `session/cancel`, routing `session/update`, logowanie, błędy procesu; atrapa agenta do testów | rozmowa z agentem z poziomu testów |
| **A2** ([#37](https://github.com/tarze07/Leverframe/issues/37)) | Agenci ACP w `agents.json` (pole `acp`), wykrywanie, wskazówki instalacji, wybór „Terminal / Rozmowa” w panelu „Agenci”; prosty panel rozmowy (tekst, zgody, logowanie, Stop, log) | agent startuje w trybie ACP jednym kliknięciem |
| **A3** ([#38](https://github.com/tarze07/Leverframe/issues/38)) | Panel rozmowy: strumień odpowiedzi (Markdown), myśli, plan, karty narzędzi (klik → plik i linia), pole promptu, Stop, komendy `/…`, tryby i opcje (`session/set_mode`, `session/set_config_option`), zużycie | pełna rozmowa w UI |
| **A4** ([#39](https://github.com/tarze07/Leverframe/issues/39)) | Zgody (`session/request_permission`), diffy w edytorze (Monaco diff), `fs/read_text_file` z niezapisanych edytorów, `fs/write_text_file` z obsługą konfliktów | agent zmienia pliki pod kontrolą użytkownika |
| **A5** ([#40](https://github.com/tarze07/Leverframe/issues/40)) | Terminale agenta (`terminal/*`, `src-tauri/src/acp/terminal.rs`): własny `PtyManager` sesji, pytanie przed poleceniem, podgląd wyjścia w karcie narzędzia i „Otwórz jako terminal”, tekst bez kodów ANSI z limitem dla agenta | agent uruchamia polecenia przez Leverframe |
| **A6** ([#41](https://github.com/tarze07/Leverframe/issues/41)) | Historia: zapis transkryptu, wyszukiwanie w panelu „Sesje”, wznawianie (`session/list`, `session/load` / `session/resume`) | rozmowy ACP w historii |
| **A7** ([#42](https://github.com/tarze07/Leverframe/issues/42)) | Testy E2E z atrapą agenta, dokumentacja, wydanie | wersja z ACP |

**MVP = A1–A4** (rozmowa, zgody, diffy) – wydane w 0.5.0. A5–A6 – w 0.6.0.

### Historia i wznawianie (A6)

- **Zapis**: transkrypt to plik JSON Lines w `recordings/` (`<czas>-<agent>-<pid>.acp.jsonl`): nagłówek, zdarzenia
  `AcpEvent` w postaci, w jakiej dostał je panel, wiadomości użytkownika (`sent`), końce tur (`turnEnded`) oraz
  znaczniki `resumed` i `reset`. UI odtwarza go **tym samym reducerem** co rozmowę na żywo, więc historia wygląda
  jak panel; nieznane zdarzenia (inna wersja zapisu) są pomijane.
- **Baza**: tabela `sessions` dostała kolumny `kind` (`terminal` / `acp`), `acp_session_id` i `title` (dodawane
  przy otwarciu starszej bazy; nagrania terminala dostają `terminal`). Tekst wiadomości i tytuły narzędzi trafiają do
  tego samego indeksu FTS5 co wyjście terminala (z zamianą `ł`→`l`), po każdej turze – rozmowę widać w wynikach,
  zanim się skończy. Wpis powstaje dopiero przy pierwszej wiadomości: otwarcie i zamknięcie panelu nie zaśmieca
  historii. Tytuł to tytuł z `session_info_update`, a bez niego – początek pierwszej wiadomości.
- **Wznawianie** rozmowy z historii: nowy proces agenta, `initialize`, potem zamiast `session/new`:
  `session/resume` (jeśli agent ma `sessionCapabilities.resume`), w przeciwnym razie `session/load`
  (`agentCapabilities.loadSession`). Przy `session/load` agent odtwarza rozmowę przed odpowiedzią – Leverframe
  pomija wtedy odtwarzane wiadomości, narzędzia i plan (UI już pokazuje historię), ale przepuszcza stan sesji
  (tryby, komendy). Dalszy ciąg dopisuje się do tego samego pliku i wpisu. Bez tych możliwości – tylko podgląd.
- **Sesje agenta** (`session/list`, `sessionCapabilities.list`): lista sesji agenta w folderze rozmowy, np.
  rozpoczętych w terminalu; otwarcie wybiera `session/load` (z widocznym odtworzeniem, bo UI nie ma kopii) albo
  `session/resume`. `session/delete` (`sessionCapabilities.delete`) tylko po potwierdzeniu, nigdy dla otwartej sesji.
  Usunięcie rozmowy z historii Leverframe nie usuwa jej u agenta.

## 7. Ryzyka i decyzje

- **v1 czy v2** – v1 (stabilne). v2 śledzimy; biblioteka Rust ma v2 tylko jako funkcję `unstable_protocol_v2`.
- **Adaptery wymagają Node.js** (Claude, Codex) – pokazujemy to we wskazówkach instalacji; w SSH/WSL adapter musi
  być po stronie zdalnej.
- **Kilo i Agy** – bez potwierdzonego trybu ACP zostają w terminalu; `agents.json` pozwala dodać komendę bez
  nowej wersji aplikacji.
- **Logowanie** – zależne od agenta/adaptera; jeśli agent zgłosi metody `authenticate`, UI je pokazuje; jeśli
  wymaga logowania w terminalu, podpowiadamy uruchomienie agenta w trybie terminalowym raz.
- **Różnice między adapterami** – testujemy na atrapie zgodnej ze schematem; prawdziwych agentów sprawdzamy
  ręcznie przed wydaniem (tego środowisko CI nie zrobi: wymagają kont).
- **Rozmiar zmian** – osobny panel i moduł; tryb terminalowy pozostaje nietknięty.
