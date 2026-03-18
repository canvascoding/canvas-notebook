# PI-first Migration Plan (Single Source of Truth)

## Status
- Owner: Canvas Notebook Team
- Date: 2026-03-06
- Scope: Vollstaendige Ersetzung der bestehenden AI-Agent-Backend-Logik durch PI
- Zuordnung der operativen Tasks: `docs/pi-first-implementation-todo.json`

## 1) Ziel
Wir ersetzen die aktuelle Agent-Engine in Canvas Notebook vollstaendig durch:
- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`

Wichtig:
- Kein dauerhafter Parallelbetrieb von Alt- und Neu-Logik im Backend.
- Nach Cutover darf in `main` kein Legacy-Agent-Code mehr vorhanden sein.

## 2) Harte Entscheidungen
1. PI-first ohne dauerhaften Legacy-Fallback in `main`.
2. Bestehende Chat-UI bleibt erhalten; PI wird in vorhandene Komponenten integriert.
3. Provider/Model/Thinking bleiben im bestehenden Settings-UI fuer Nutzer editierbar.
4. `pi-web-ui` ist optional und aktuell nicht Teil des Pflichtpfads.
5. `pi-tui` ist optional (z. B. spaeter im Terminal), nicht blockierend fuer Web-Integration.
6. Upstream-Code von Mario wird moeglichst nicht veraendert; Anpassungen erfolgen in lokaler Adapter-Schicht.

## 3) Paket-Installation im Repository
Arbeitsverzeichnis:
`/Users/frankalexanderweber/.openclaw/workspace-mango-jerry/canvasstudios-notebook`

Pflichtpakete:
```bash
npm install --save-exact @mariozechner/pi-ai@0.56.2 @mariozechner/pi-agent-core@0.56.2
```

Optionale Pakete:
```bash
npm install --save-exact @mariozechner/pi-tui@0.56.2
npm install --save-exact @mariozechner/pi-web-ui@0.56.2 @mariozechner/mini-lit@0.2.0 lit@3.3.1
```

Technische Voraussetzung:
- Node.js >= 20

## 4) Zielarchitektur

### 4.1 Integrationsprinzip
Wir halten PI-Pakete unveraendert und bauen eine duenne Integrationsschicht in diesem Repo.

Empfohlenes Modul-Layout:
- `app/lib/pi/model-resolver.ts`
- `app/lib/pi/api-key-resolver.ts`
- `app/lib/pi/tool-registry.ts`
- `app/lib/pi/session-store.ts`
- `app/lib/pi/stream-proxy.ts`

### 4.2 Backend-Fluss
1. UI sendet Prompt an Backend.
2. Backend loest Provider/Model/Thinking aus zentraler Config auf.
3. Backend loest API-Key serverseitig aus bestehendem Env-Store auf.
4. `pi-agent-core` fuehrt Agent-Loop inkl. Tools aus.
5. Events werden als Stream an UI gemappt.
6. Session-Context wird PI-kompatibel persistiert.

### 4.3 Session-Persistenz
- Altes textzentriertes Persistenzmodell wird auf PI-Context-Persistenz erweitert.
- Session bleibt providergebunden.
- Resume/Continue arbeitet auf dem PI-Context.

### 4.4 Settings
Bestehendes Settings-UI bleibt, wird aber auf PI-Felder umgestellt:
- Provider
- Model
- Thinking Level
- optional Tool-/Policy-Einstellungen

## 5) No-Mix-Policy und Cutover

### 5.1 Grundsatz
In `main` gilt PI-only. Kein Legacy-Agent-Backend parallel.

### 5.2 Migration in Branch
Ein temporaerer Schalter fuer Branch-Validierung ist zulaessig, muss aber vor Merge entfernt werden.

### 5.3 Finaler Cutover
1. Neue PI-Route aktiv.
2. Legacy-Chat-Routen und Legacy-Resolver loeschen.
3. Alte Provider-spezifische Stream-Parser entfernen.
4. CI-Gates aktivieren, die Legacy-Referenzen hart blockieren.

## 6) Upstream-Update-Strategie (Mario-kompatibel)
1. Keine direkten Aenderungen in Mario-Paketquellen.
2. Anpassungen nur in lokaler Adapter-Schicht.
3. Falls absolut noetig: temporaer `patch-package`, parallel Upstream-Issue/PR.
4. Zielzustand: Patch wieder entfernen.
5. Regelmaessig pinned Versionen pruefen und kontrolliert updaten.

## 7) Test- und Abnahmeprotokoll

### 7.1 Container-Regeln
- Immer genau ein Test-Container.
- Vor jedem manuellen Lauf: Rebuild + Recreate.
- Manueller Test immer auf Port `3000`.

### 7.2 Standardablauf
```bash
docker compose down --remove-orphans
docker compose up -d --build --force-recreate
docker compose ps
E2E_EXTERNAL_SERVER=1 BASE_URL=http://localhost:3000 npm run test:e2e
```

### 7.3 Login fuer manuelle Tests
- Email: `BOOTSTRAP_ADMIN_EMAIL`
- Passwort: `BOOTSTRAP_ADMIN_PASSWORD`

## 8) Implementierungsreihenfolge
Die verbindliche Reihenfolge ist in `docs/pi-first-implementation-todo.json` definiert.
Regel:
- Immer nur am naechsten offenen Todo arbeiten.
- Kein Weitergehen, solange das vorherige Todo nicht fertig ist.
- Abschluss pro Todo mit sauberem Commit (kein Push).

## 9) Definition of Done
Das Vorhaben ist abgeschlossen, wenn:
1. Das Backend PI-only laeuft.
2. Kein Legacy-Agent-Backendcode mehr in `main` existiert.
3. Provider/Model/Thinking im Settings-UI editierbar sind.
4. Chat, Streaming, Tool-Events und Session-Resume mit PI stabil funktionieren.
5. CI no-legacy Gates aktiv sind.
6. Container-/E2E-Protokoll erfolgreich durchlaufen wurde.

## 10) Referenzen
- Taskliste: `docs/pi-first-implementation-todo.json`
- Historischer Alt-Plan (nur Referenz): `docs/agent_implementation_plan.md`
- PI AI: https://github.com/badlogic/pi-mono/tree/main/packages/ai
- PI Agent Core: https://github.com/badlogic/pi-mono/tree/main/packages/agent
