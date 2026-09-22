# Managed Settings Updates: Umsetzungsplan und Abnahme

Stand: 2026-09-22

## Ziel und Grenzen

Ein Instanzadministrator kann ein zentral freigegebenes Update in Settings starten,
den Fortschritt auch waehrend des Containerwechsels verfolgen und nach Wiederkehr
der App den verifizierten Abschluss oder einen Fehler sehen.

Verbindlicher Weg: Notebook UI -> Notebook API -> Control Plane -> bestehender
Agent-WebSocket -> Host-Agent -> vorhandene Host-CLI. Die Control Plane behaelt
Releaseauswahl, persistente Runs, Sperren, Policy und abschliessende Verifikation.
Es entsteht kein zweiter Docker-Updatepfad und kein allgemeiner Host-Shell-Zugang.
Standalone behaelt seinen Unix-Socket-Updater.

## Ausgangsbefund

- Notebook erwartet `/v1/managed-system-updates`; die gepruefte Control Plane
  implementiert diesen Vertrag nicht und behandelt ihn als Benutzer-Session-API.
- Der vorhandene Managed-Token erreicht dort HTTP 401.
- Die lokale VM verwendet `http://host.orb.internal:4001`; das neue Notebook-Backend
  erlaubt HTTP nur an Loopback-Adressen.
- Agent-Phasen werden aus Terminaltext abgeleitet, obwohl die CLI bereits
  `--event-stream --operation-id` unterstuetzt.
- Das Managed-Backend liefert keinen unabhaengigen Statuszugang.
- Der bestehende Architekturplan bezeichnet Phase 7 voreilig als abgeschlossen.
- Vorhandene VM: App/CLI 2026.8.29.5. Lokaler Docker-Stack: Notebook 2026.9.16.2,
  Update-Worker deaktiviert, Notebook ohne Instanz-Token im manuellen Modus.
  Diese laufenden Artefakte gelten nicht als Abnahme des neuen Quellstands.

## Gemeinsamer Schnittstellenvertrag

Kanonischer Namespace: `/v1/managed/system-updates`.

| Aufruf | Ergebnis |
| --- | --- |
| GET `/availability?channel=stable` | `SystemUpdateAvailability`, contractVersion 1 |
| POST `/` mit `channel`, `expectedReleaseId` | 202 mit `{ operation }`, erst nach persistenter Uebergabe |
| GET `/:operationId` | `{ operation }` fuer die authentifizierte VM |
| GET `/:operationId/events?after=N` | `{ operation, events }`, monotoner Journal-Cursor |
| POST `/:operationId/status-ticket` | kurzlebiger, nur lesbarer und operationsgebundener Statuszugang |

Operationen und Events entsprechen den vorhandenen Notebook/CLI-Typen. Die
oeffentliche operationId ist die persistente Run-Item-ID; interne cmdIds und
Release-Image-Referenzen bleiben serverseitig. `succeeded` bedeutet zentral
verifizierten Erfolg, nicht bloss einen CLI-Exitcode. Ein verifizierter Rollback
wird von Fehlern und unklaren Zustaenden unterschieden.

Instanz-Tokens duerfen nur ihre eigene VM und deren Operationen ansprechen.
Neue Berechtigungen fuer Update-Lesen und -Start werden explizit eingefuehrt und
bestehende provisionierte Tokens kontrolliert migriert. Browser erhalten weder
Instanz-Token noch frei waehlbare Images, VM-IDs oder Shell-Befehle.

Der Statuszugang verwendet dieselben Snapshot-Daten und kann direkt von der
Control Plane gelesen werden. Ein Ticket gilt nur fuer eine Operation, laeuft ab
und erlaubt keine Mutation. Die UI akzeptiert ausschliesslich serverseitig
validierte URLs; CORS und Credential-Verhalten muessen dazu passen. Standalone-
SSE bleibt kompatibel. REST-Polling bleibt der verbindliche Recovery-Pfad.

Lokales HTTP ist nur ueber eine ausdrueckliche Entwicklungs-Konfiguration fuer
konkrete lokale Hosts erlaubt; der HTTPS-Standard fuer Produktion bleibt bestehen.
Ein als Managed konfiguriertes Notebook mit fehlenden Credentials darf nicht
stillschweigend auf einen anderen Update-Verantwortlichen wechseln.

## Arbeitspakete und Gates

### Gate 1: Plan und Arbeitsumgebungen

- [x] Befunde und Vertrag dokumentieren.
- [x] Separate Arbeitsbranches fuer Notebook und Control Plane anlegen.
- [ ] Plan nach GitNexus-Aenderungspruefung committen.

### Gate 2: Implementierung (ein gemeinsamer Meilenstein mit drei Subagenten)

Die drei Teilbereiche duerfen nach Gate 1 parallel umgesetzt werden. Gate 3
beginnt erst, wenn alle Teilbereiche abgeschlossen und zusammengefuehrt sind.

1. **Control-Plane-API:** neue instanzgebundene Routen, Scope-Migration,
   Readiness/Release-Pruefung, Wiederverwendung der bestehenden Start-Orchestrierung,
   Ownership-Pruefung fuer Status/Events, kurzlebiger Statuszugang, Tests fuer
   Cross-VM-Zugriffe, Worker-offline, Releasewechsel und konkurrierende Starts.
2. **Host-Agent:** strukturierte CLI-Ereignisse validieren und inkrementell parsen,
   Operation-ID zuordnen, Events ins vorhandene Journal transportieren; CLI-
   Faehigkeit vor Start pruefen. Locks, Deadlines, Pre-/Postflight und CLI-Rollback
   beibehalten. Tests fuer Chunk-Grenzen, falsche IDs, ungueltige Events und
   Rueckwaertskompatibilitaet.
3. **Notebook:** Namespace und Backend-Auswahl korrigieren, lokale URL-Policy
   explizit machen, direkten Ticket-Status abrufen und nach App-Reconnect abgleichen,
   permanente Auth-/Not-found-Fehler von Downtime unterscheiden. Tests fuer
   Managed/Standalone/Manual, Ticket-Validierung und Recovery.

### Gate 3: Integration und Abnahme

- [ ] Gemeinsame Payloads gegen echte Parser beider Repositories pruefen.
- [ ] Fokussierte Tests sowie Control-Plane-Typecheck und Notebook-Build erfolgreich.
- [ ] GitNexus detect_changes vor jedem Implementierungscommit; nur erwartete Pfade.
- [ ] Bestehenden lokalen Stack nur nach expliziter Build-Freigabe aktualisieren;
      vorher erfolgreicher Host-Build, keine weitere Testumgebung starten.
- [ ] Browser-Abnahme nur nach ausdruecklicher Playwright-Freigabe.
- [ ] Echte VM-Abnahme: Start, persistente Annahme, Containerwechsel, direkter Status,
      Wiederverbindung, verifizierte Zielversion; Rollback separat kontrolliert testen.
- [ ] Nicht ausgefuehrte oder blockierte Laufzeitpruefungen ausdruecklich dokumentieren.

### Gate 4: Abschluss

- [ ] Architekturstatus und Ergebnisse aktualisieren.
- [ ] Logische Aenderungen in beiden Repositories separat committen.
- [ ] Commits, Testnachweise und verbleibende Betriebsanforderungen dokumentieren.

## Abnahmekriterien

- Die reale Control-Plane-Route und ihr Auth-Pfad sind durch Tests abgedeckt;
  reine Notebook-Mocks gelten nicht als Integrationsnachweis.
- Bei deaktiviertem Worker, fehlendem Agenten oder nicht freigegebenem Release
  wird kein scheinbar ausfuehrbarer Updateauftrag angenommen.
- Eine Instanz kann weder fremde Operationen lesen noch fremde VMs aktualisieren.
- Start und Releasepruefung verhindern einen unbemerkten Zielwechsel.
- Status ist nach Verlust der App-Verbindung rekonstruierbar; keine Endlosschleife
  fuer abgelaufene Anmeldung oder geloeschte Operationen.
- Erfolg wird nur aus der zentralen Verifikation abgeleitet.
- Keine Secrets in Browser-Payloads, Logs, Tests oder Dokumentation.

## Durchfuehrungsprotokoll

Wird mit abgeschlossenen Schritten, Testbefehlen und Einschraenkungen ergaenzt.
