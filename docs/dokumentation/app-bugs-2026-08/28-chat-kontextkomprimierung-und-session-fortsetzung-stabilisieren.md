---
title: 'Ticket 28: Chat-Kontextkomprimierung und Session-Fortsetzung stabilisieren'
status: open
priority: high
depends_on: []
platforms: [server, agent-runtime, web]
tags: [type/bug, topic/agents, topic/chat, topic/context-window, topic/sessions]
---

# Ticket 28: Chat-Kontextkomprimierung und Session-Fortsetzung stabilisieren

> Detaillierter, am aktuellen Codebestand und am lokalen Hermes-Referenzstand
> ausgerichteter Umsetzungsplan:
> [28-chat-kontextkomprimierung-umsetzungsplan.md](./28-chat-kontextkomprimierung-umsetzungsplan.md)

## Problem

Wenn ein Chat das Kontextfenster des gewaehlten Modells erreicht, muss die
Runtime den bereits abgearbeiteten Verlauf sicher in eine interne
Zusammenfassung ueberfuehren und anschliessend ohne Verlust des aktuellen
Arbeitsauftrags fortsetzen. Dieser Ablauf funktioniert derzeit nicht
zuverlaessig. Dadurch kann ein Chat am Kontextlimit stehen bleiben, wiederholt
an derselben Grenze scheitern oder nach einer Komprimierung den relevanten
Auftrags-, Tool- oder Sessionzustand verlieren.

Die bereits vorhandene PI-Runtime besitzt Zusammenfassungszustand mit
Zeitstempel und Sequenzgrenze sowie einen manuellen `compact`-Pfad. Das Ticket
klaert zuerst reproduzierbar, an welcher Grenze der reale Fehler entsteht:
Budgetberechnung, automatische Ausloesung, Zusammenfassungsaufruf,
Persistierung, erneuter LLM-Request oder Wiederaufnahme einer geladenen
Session.

## Referenzanalyse: Hermes-Agent (Stand 2026-08-23, Budgetanalyse 2026-08-26)

Der lokale Checkout `../hermes-agent` wurde per Fast-forward auf
`f293e7206b4ddd66042329442c6afebc19a8808d` (Upstream `main`, 2026-08-14)
aktualisiert und nur als fachliche Referenz gelesen. Daraus wird kein Code
uebernommen.

Folgende, fuer Canvas relevante Muster wurden verifiziert:

- `agent/context_compressor.py` trennt einen geschuetzten Kopf und einen
  tokenbudgetierten aktuellen Tail von dem komprimierbaren Mittelteil. Es
  markiert die Zusammenfassung explizit und achtet beim Wiedereinsetzen auf
  gueltige Nachrichten-/Tool-Reihenfolge.
- `agent/conversation_compression.py` nutzt einen Commit-Fence: Nach Timeout
  oder Abbruch darf eine im Hintergrund laufende Zusammenfassung nicht spaeter
  den aktiven Verlauf oder persistenten Sessionzustand ueberschreiben. Pro
  Session werden parallele Komprimierungen serialisiert.
- Die Tests pruefen explizit Zusammenfassungs-Kontinuitaet nach Neustart,
  Entfernung von sessionfremdem Altzustand sowie das Ruecksetzen von
  Cooldown-/Fehlerzaehlern am Sessionende. Ein fehlgeschlagener
  Zusammenfassungsaufruf laesst den Verlauf unveraendert oder verwendet einen
  klar gekennzeichneten, kontrollierten Fallback.
- Die optionale Micro-Compaction ist bewusst kein Default: Sie amortisiert
  grosse Komprimierungen, invalidiert aber durch Umschreiben des Verlaufs den
  Prompt-Cache. Fuer Canvas ist das eine spaetere Produkt-/Kostenentscheidung,
  nicht die erste Fehlerbehebung.

Diese Erkenntnisse sind als Qualitaetsmassstab zu verwenden. Canvas soll seine
eigene Daten-, Sicherheits- und Providerarchitektur beibehalten.

Die anschliessende Detailanalyse des Hermes-Kontextbudgets hat die
Umsetzungsreihenfolge geschaerft. Hermes berechnet aus dem Modellfenster
zunaechst ein effektives Eingabefenster nach Abzug der vorgesehenen Ausgabe,
zaehlt Systemprompt, Nachrichten und Toolschemas gemeinsam und vergleicht
seine Schaetzung spaeter mit gemeldeter Provider-Usage. Fuer Canvas sind davon
der vollstaendige Request-Blick, die Ausgabe-Reserve, atomare Toolgruppen und
die Verwendung realer Usage als kalibrierende Evidenz uebertragbar.

Nicht uebernommen werden Hermes' feste Schwellen/Floors, Python-Threading,
Gateway- und Session-Rotation, Recovery-Pointer, Micro-Compaction,
Prompt-Cache-Annahmen oder statische destruktive Fallbacks. Insbesondere ist
eine Provider-Usage-Meldung keine universelle Tokenwahrheit: Sie gilt nur als
Evidenz fuer die konkrete Modell-/Provider-/Payload-Konfiguration und erhaelt
eine explizite Konfidenz.

## Zielzustand

- Lange Chats laufen beim Erreichen des Kontextlimits kontrolliert weiter; die
  aktuelle Nutzeranfrage, der juengste relevante Verlauf und notwendige
  Toolergebnisse bleiben nutzbar.
- Automatische und manuelle Komprimierung verwenden denselben sicheren,
  beobachtbaren Zustandsvertrag. Eine Komprimierung wird ausreichend vor dem
  harten Providerlimit gestartet und beruecksichtigt Systemprompt, effektive
  Tools, Runtime-Kontext, Ausgabe-Reserve, Bild-/Anhangsbudgets sowie die
  neueste Nachricht.
- Zusammenfassungstext und seine eindeutige Sequenz-/Zeitgrenze werden
  atomar und nur nach erfolgreicher Erstellung persistiert. Nach Reload oder
  Retry wird weder schon zusammengefasster Verlauf doppelt geladen noch
  sessionfremder Zusammenfassungstext uebernommen.
- Bei Abbruch, Provider-/Netzwerkfehler oder zu grosser letzter Nachricht
  bleiben die Originalnachrichten erhalten. Die UI zeigt einen eindeutigen
  handlungsfaehigen Status statt eines stillen Hangs oder einer Retry-Schleife.
- Workspace-, Nutzer-, Agenten- und Session-Grenzen bleiben erhalten. Inhalte
  aus Zusammenfassungen bleiben untrusted Kontext; Secrets, rohe Anhaenge und
  Credentials duerfen nicht in UI, Logs oder Telemetrie gelangen.

## Implementierungsstand 2026-08-27

Die beiden Budget- und Kompositionsvertragsphasen sind technisch umgesetzt
und automatisiert geprueft. Live-Chat und persistente Automation setzen nun einen expliziten
Hauptrequest-Ausgabecap und verwenden denselben Wert als Reserve. Unmittelbar
nach der bestehenden finalen Nachrichten-/Bildnormalisierung entsteht ein
unveraenderlicher, fingerprintgebundener Snapshot fuer effektive
Anweisungen, Nachrichten, Toolschemas, Runtime-/Provideroverhead,
Multimodalkosten, Safety und Bytegrenzen. Raw-History-Schnitte erhalten
ToolCall/Result-Gruppen atomar. Provider-Usage kann nur als nachtraegliche
Evidenz mit expliziter Konfidenz am konkreten Contractfingerprint haengen.

Der Summaryplanner verwendet nun die testbare Canvas-Policy fuer
Soft-Trigger, Target-Tail und Hardlimit. Er haelt Summary-Abdeckung und
Roh-Tail nach Sequenz auseinander, entfernt interne Marker aus dem
Modellpayload, schuetzt den aktuellen Nutzerturn samt nachfolgender Toolkette
und gibt fuer Live, Manual und Automation ein gemeinsames `safeToSend`-Urteil
aus. Bei Summary-Fehlern wird nur dann mit Rohhistorie fortgesetzt, wenn sie
vollstaendig in das Hardlimit passt; sonst endet der Request vor dem Provider
und ohne Nachrichtenverlust.

Als zweite Phase ist nun auch das additive Persistenzfundament technisch
umgesetzt. Sessions tragen eine monotone Summary-Revision; ein inhaltsfreies
Attempt-Ledger erfasst Start, Checkpoint, Scope, Ergebnis und stabile
Grundcodes. SQLite und PostgreSQL auditieren bestehende Nachrichtensequenzen,
bevor sie den eindeutigen `(Session, Sequenz)`-Index aktivieren. Start,
Fehlerabschluss und Summary-Erfolg besitzen transaktionale Store-Operationen.
Der Erfolgscommit akzeptiert nur die unveraenderte Basisrevision und den
persistierten Nachrichtencheckpoint und laesst spaetere, parallel angehaengte
Nachrichten stehen. Allgemeine Session-Saves und die No-op-Finalisierung sind
gegen stale Summary-Ueberschreibungen eingezaeunt.

Der Phase-3-Coordinator ist ebenfalls implementiert und automatisiert
geprueft. Er dedupliziert Versuche pro Session, kapselt
Kandidatenerzeugung hinter Abort-, Generation- und Gesamt-Timeout-Fences,
verwirft spaete Providerergebnisse und wendet eine injizierbare Canvas-Retry-
Policy an. Cooldown, einmaliger manueller Bypass und Reset nach Erfolg werden
restartfest aus dem inhaltsfreien Attempt-Ledger bestimmt. Eine monotone
Attempt-Ordinalzahl und explizite Attempt-Indizes sichern diesen Vertrag auch
bei gleicher Zeitsekunde und in PostgreSQL. Live-Chat und manuelles
Komprimieren laufen inzwischen ueber diesen Coordinator. Nachrichten werden
vorher dauerhaft checkpointbar gemacht; erst nach erfolgreichem CAS-Commit
werden Summary, Erfolgsevent und Break-Marker mit gemeinsamer Attempt-ID in
die Runtime uebernommen. Abort, Dispose, Timeout sowie Prompt-/Tool-/Runtime-
Invalidierung verwerfen auch spaete Providerergebnisse. Ein Runtime-
Integrationstest prueft Erfolg/Reload, Manual-Auto-Race, Abort, Stale State,
Timeout und Late Results.

Die persistente Automation verwendet nun ebenfalls Coordinator,
Attempt-Ledger und revisions-/watermark-geprueften Commit. Ihre allgemeinen
Prompt-, Ergebnis-, Fehler- und No-op-Saves schreiben keinen Summaryzustand
mehr. Ein fokussierter Reload-Test belegt monotonen Fortschritt ab dem bereits
committeten Watermark. Managed Delegations und Telegram-`/compact` nutzen den
Live-/Manual-Pfad; ephemeral Worker bleiben als nicht fortsetzbare, getrennte
Grenze bewusst ausserhalb.

Der Runtime-/UI-Vertrag transportiert jetzt einen inhaltsfreien
`compactionStatus` mit Attempt-ID, Zustand, Grundcode und Retry-Zeitpunkt.
Die Chat-Oberflaeche stellt Running, Success, No-op, Deferred, Too-large,
Abort, Stale und Failure lokalisiert dar, sperrt doppelte Compact-Aufrufe und
haelt Abort erreichbar. Event und persistierter Marker werden per Attempt-ID
dedupliziert; Inhaltsdaten verlassen den Server dabei nicht.

Noch **nicht** abgenommen sind die Browser-/Playwright-Darstellung sowie die
manuelle Langchat-, Tool-, Reload- und Multimodal-Matrix. Das Ticket bleibt
offen.

Die nicht-browserbasierte technische Testauswahl fuer Budget, Summary,
Persistenz, Concurrency-Fences, Live- und Automation-Fortsetzung, UI-Vertrag
und Multimodalpfade sowie Lint und Produktions-Build ist am 2026-08-27 gruen
durchgelaufen. Lokale Auth-Base-URL-Hinweise im Build sind bekannte
Umgebungswarnungen und kein Ticket-28-Fehler.

## Umsetzung

Die erste Implementierungsphase ist jetzt der gemeinsame Budgetvertrag, noch
vor Coordinator-, Persistenz- oder breiteren Komprimierungsaenderungen. Fuer
jede konkrete Hauptmodell-Anfrage wird genau ein unveraenderlicher Snapshot
aus dem finalen Payloadzustand gebildet. Er umfasst:

- effektive System-/Developer-Anweisungen und Runtime-Promptbloecke;
- final serialisierte Nachrichten einschliesslich Bild-/Anhangsevidenz;
- die effektiv gesendeten Toolschemas und Provider-/Runtime-Envelope;
- eine Ausgabe-Reserve, die exakt dem an den Provider gesendeten
  `maxTokens`-Cap entspricht, plus explizite Sicherheitsreserve;
- Modell-, Prompt-, Tool- und Payload-Fingerprints als
  Invalidierungsgrenzen sowie die Schaetz-/Kalibrierungskonfidenz.

Der zugehoerige History-Planer arbeitet mit unteilbaren Einheiten. Ein
Assistant-ToolCall und alle zugehoerigen Toolresultate werden gemeinsam
behalten oder gemeinsam aus dem Raw-Tail entfernt. Trigger- und Zielwerte
sind Canvas-Policy, injizierbar und testbar; Hermes-Konstanten werden nicht
hardcodiert.

- Einen reproduzierbaren Fehlerfall mit Modell, effektiver Kontextgroesse,
  Systemprompt-/Toolumfang, Runtime-Kontext, Nachrichtenfolge und erwarteter
  Fortsetzung erfassen. Mindestens Text-, Toolresultat- und Bild/Anhangsfall
  getrennt betrachten.
- Die Budgetberechnung und Ausloesung in `history-budget`,
  `session-summary` und `live-runtime` als einen Vertrag pruefen. Harte
  Providergrenzen duerfen nicht erst nach einer nicht mehr rettbaren Anfrage
  festgestellt werden; eine einzelne neue Nachricht, die bereits allein zu
  gross ist, braucht dagegen eine klare, nicht destruktive Fehlermeldung.
- Einen serialisierten Komprimierungsversuch pro Session einrichten. Erfasst
  der Versuch einen Timeout, Abbruch oder eine konkurrierende Mutation, darf
  sein Ergebnis nur nach einem gueltigen Commit der noch aktuellen Session
  uebernommen werden.
- Die Persistierung von Zusammenfassung, `summaryThroughSequence`,
  Zeitgrenze und komprimiertem Kontext pruefbar zusammenziehen. Reload,
  erneutes Senden, manuelles Komprimieren und Agenten-/Tool-Weiterarbeit
  muessen dieselbe kanonische Fortsetzung erhalten.
- Den Inhalt der Zusammenfassung robust strukturieren: aktiver Auftrag,
  Entscheidungen, aenderte Dateien/Artefakte, relevante Toolresultate,
  offene Punkte und naechster Schritt. Alte Zusammenfassungen werden
  kontrolliert ersetzt oder verdichtet; sie duerfen nicht unkontrolliert
  anwachsen oder alte Nutzeranweisungen als neue Anweisung ausgeben.
- Wiederholte erfolglose Versuche begrenzen und instrumentieren: Grund,
  Ausloeser (automatisch/manuell), vorher/nachher Budget, ausgesparte bzw.
  gesicherte Nachrichtenanzahl, Dauer und Ergebnis. Kein Inhaltslogging.
- In der Chat-Oberflaeche einen ruhigen Status fuer Erfolg, laufende
  Komprimierung, no-op, nicht komprimierbare letzte Nachricht und fehlende
  Zusammenfassung anbieten; eine unklare leere oder blockierte Unterhaltung
  ist nicht akzeptabel.
- Mit Ticket 18 bei Systemprompt-/Toolbudget und Ticket 26 bei Bild-/Anhangs-
  budgets koordinieren. Keine harte Abhaengigkeit, aber gemeinsame
  Budgetannahmen duerfen nicht auseinanderlaufen.

## Abnahmekriterien

- Ein kontrollierter langer Textchat ueberquert die Ausloeseschwelle,
  komprimiert genau einmal und beantwortet bzw. bearbeitet die aktuelle
  Aufgabe anschliessend mit erhaltenen Entscheidungen und dem juengsten
  Verlauf.
- Toolintensive Verlaeufe, einschliesslich langer Read-/Edit-Ergebnisse,
  bleiben nach Komprimierung fortsetzbar; Toolpaare und Nachrichtenreihenfolge
  bleiben providerkonform.
- Ein Bild-/Anhangsfall beruecksichtigt dessen Budget korrekt und erhaelt die
  Sicherheitsgrenzen aus Ticket 26.
- Ein Fehler, Timeout oder Abbruch beim Zusammenfassen entfernt oder
  ueberschreibt keine Originalnachricht. Ein zweiter Versuch kann kontrolliert
  erfolgen, ohne in eine Endlosschleife zu geraten.
- Parallel ausgeloste manuelle/automatische Versuche und ein Session-Reload
  erzeugen keine doppelte, veraltete oder fremde Zusammenfassung. Eine
  Wiederaufnahme nutzt exakt die aktuelle Sequenzgrenze.
- Die UI macht Ergebnis und naechste sinnvolle Aktion klar, ohne
  Zusammenfassungsinhalt, Anhaenge oder Credentials offen zu legen.

## Tests und Abschluss

- Unit-/Contract-Tests fuer Budgetgrenzen, Sequenzreihenfolge,
  Zusammenfassungsfortschreibung, zu grosse Einzelanfragen, Fehler/Abbruch,
  Retry-Cooldown und konkurrierende Komprimierung.
- Integrations-Tests fuer Persistierung, Session-Reload, Toolresultate,
  Runtime-Prompt-Kontext und Modell-/Providerwechsel.
- Manueller langer Chat mit Text, Toolaufrufen und einem kontrollierten
  Bild-/Anhangsfall; UI-/Browser-Tests erst nach expliziter Freigabe.
- `npm run build` nach Server-/Runtime-Aenderungen; eigener fokussierter
  Commit und anschliessende Statusaktualisierung im [Index](./README.md).
