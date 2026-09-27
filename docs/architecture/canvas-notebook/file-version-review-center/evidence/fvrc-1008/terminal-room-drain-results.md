# Terminaler lokaler Room-Drain und sichere Startup-Zulassung

Stand: 27. September 2026. Aufbauend auf `34af3f1e0` und dem
[Release-Beleg](room-release-results.md). FVRC-1008 bleibt in Arbeit.

## Implementierter Umfang

Die optionale Ownership-Runtime bindet einen terminalen Drain an genau eine
bereits geladene Doc-Instanz und ihren vollständigen Scope. Neue Aktivitäten
sind sofort gesperrt; zuvor zugelassene Aktivitäten dürfen tatsächlich fertig
werden. Der Owner-Fence bleibt während dieser Phase für deren finalen Store
gültig. Weder ein Timer noch ein Socket-Abbruch erklärt laufende Arbeit für
beendet.

Der Collaboration-Server installiert ausschließlich bei aktivierter optionaler
Ownership einen lokalen Drain-Handler. Dieser prüft Scope/Instanz unter der
Lifecycle-Sperre, setzt Peers read-only und schließt sie. Anschließend wartet er
ohne Workspace-, Room-, Save- oder SQL-Sperre auf Activity null. Erst danach
erwirbt er den konkreten Room-Mutex, prüft erneut und fordert einen finalen Store
über die normale Hocuspocus-Speicherwarteschlange an.

Hocuspocus verschluckt Speicherfehler. Deshalb entscheidet nicht dessen
zurückgekehrtes Promise, sondern der atomare PostgreSQL-Release-Beleg über die
Freigabe: vollständige Yjs-Bytes samt Vector und exaktem Fence, nicht nur Text
oder Zeilennummern. Erst danach darf exakt diese alte Doc-Instanz entladen werden.
Ein alter Unload-Versuch wird abgewartet; anschließend prüft der Handler das
tatsächliche Destroy und entfernt erst dann die lokale Admission-Sperre.
Ein schon laufender normaler Unload wird vor Beginn des Drains als busy
abgewiesen: Er kann den asynchronen Before-Unload-Hook bereits passiert haben
und würde dessen Zulassungsentscheidung anschließend nicht erneut prüfen.

Bei ungewissem Release muss zuerst die alte Owner-Sitzung nachweislich schließen.
Schlägt auch das fehl, findet keine Recovery statt. Die optionale lesende
Receipt-Recovery darf nur den gespeicherten Beleg bestätigen, nie erneut
anwenden. Bei erfolgreichem Nachweis wird nur die alte Doc unloadbar; andere
Räume einer verlorenen Shared Session bleiben quarantänisiert. Fehlender Beleg,
Scope-Wechsel und fehlgeschlagenes Speichern öffnen die Zulassung nicht.

## Startup-Races

Authentifizierung, Dokumentladen und `connected` teilen eine nicht verfallende
Startup-Aktivität. `cancel` sperrt weitere Phasen, `finish` bestätigt deren
tatsächlichen Abschluss. Eine noch laufende Phase hält die Aktivität selbst
dann, wenn bereits `finish` angefordert wurde. Das verhindert insbesondere eine
vorzeitige Freigabe zwischen erfolgreichem Load und dem anschließenden Aufbau
der Hocuspocus-Connection.

Der Server verwendet den öffentlichen `createDocument`-Aufruf und eine
`WebSocketLike`-Fassade; keine Dependency-/Lockfile-Änderung. Der Request erhält
ein AbortSignal für Transportfehler. Auth-/Load-Fehler, `connected` und
`onDisconnect` bilden explizite Abschlussgrenzen. Die ausgehende
PermissionDenied-Antwort schließt zusätzlich den Fall, dass Hocuspocus bei
geschlossenem Socket seinen Hook-Context bereits nach Auth gelöscht hat. Dieser
Fallback beendet nur abgebrochene Versuche vor dem Load, keine parallele bereits
geladene Connection. Verbindungsfehler im `connected`-Hook schließen die bereits
registrierte Connection ausdrücklich.

## Abnahme

Sieben Startup-Unitfälle prüfen insbesondere Cancel ohne Settlement, wirkliche
Beendigung verschachtelter Phasen und explizites Finish. Die Runtime-Suite
besteht mit zwölf Szenarien; ergänzt sind exact-Doc-Drain, Snapshot-Copy,
Release-/Recovery-Reihenfolge, fehlgeschlagene Session-Schließung ohne Recovery
und Wiederfreigabe erst nach bestätigtem Destroy.

Die echten Hocuspocus-Serverpfade prüfen zugelassenen Direct-Auftrag vor dem
Room-Mutex, finalen Store mit Altinhalt plus Direct-Änderung, bytegleichen
Release-Snapshot, blockiertes Normal-Unload, falschen Scope, geschluckten
Storefehler ohne falsche Bestätigung und Lost-Ack-Recovery nur für die alte Doc.
Der abschließende Regressionstest hält normales Unload nach dessen bereits
erteilter Freigabe an: Terminal-Drain wird ohne Gate-/Fence-Änderung abgewiesen,
normales Unload endet genau einmal und eine frische Doc-Instanz übernimmt danach.
Owner/SQL und Workspace-Lock sind in diesem Harness simuliert. Das ist kein
vollständiger PostgreSQL-/Mehrprozess-Handoff-Nachweis.

Ein gesonderter echter Hocuspocus-ClientConnection-Test prüft Auth-Fehler, Close
während Auth/Load, fehlgeschlagene Authenticated-Antwort, einen parallelen
Startup auf anderem Request, Load-Fehler, die echte Lücke nach Abschluss des
Server-Load-Wrappers vor Connection-Erzeugung, Fehler in `connected` und
Multiplex-Isolation. Netzwerk, Auth und Datenquelle sind kontrollierte Doubles;
die installierten Hocuspocus-4.4-Receiver-/Setup-/Disconnect-Pfade sind echt.

Diese Prüfung fand ein reales Pre-Claim-Cleanup-Leck: Bei fehlgeschlagenem
erstem State-Load war die Doc noch nicht in Hocuspocus.documents; dessen Unload
tat nichts und ließ den Awareness-Timer weiterlaufen. Der gesamte Load-Hook
liegt jetzt im Cleanup-Bereich, und der Test prüft das tatsächliche Destroy.
Der erste Lauf blieb daher nach erfolgreichen Assertions hängen und wurde
beendet; nach dem Produktfix endet er ohne erzwungenes process.exit erfolgreich.

Die komplette Lifecycle-Suite besteht einschließlich des abschließenden
Unload-Guards (`/tmp/fvrc1008-terminal-drain-lifecycle-verified.log`).
Die sechs echten PostgreSQL-Receipt-Fälle bestehen erneut in einem isolierten,
anschließend entfernten Schema (`release-pg.log`, gleicher Präfix). Operations
mit Personal-Workspace-Abdeckung bestand in einer neu migrierten UUID-Datenbank,
die anschließend entfernt wurde (`operations.log`). Projection besteht ebenfalls.
Der Produktionsbuild mit 353 Seiten und Lizenzprüfung ist einschließlich des
Unload-Guards grün (`build-verified.log`).
Einzelne Baustein-Tests sind keine Freigabe für einen Mehrprozess-Rollout.

Vollständiges TypeScript und fokussiertes ESLint bestehen nach dem abschließenden
Unload-Guard (`types-post-unload.log`, `lint-post-unload.log`, gleicher Präfix).
Ein zwischenzeitlicher Test-Typfehler und ein `no-this-alias`-Lintfehler wurden
vor Abschluss korrigiert; die alten fehlgeschlagenen Zwischenlogs bleiben erhalten.

Nach frischem Start des Host-Dev auf **127.0.0.1:3000** bestehen die gewöhnlichen
B/C-Browserfälle: Personal **23,9 s**, Team **16,0 s**. C wird angenommen,
B bleibt als konkreter Konflikt mit separater/ersetzender Weiterbearbeitung
sichtbar, ohne Timeline-Fehler. Exakter Endtext und Revision sind geprüft;
beide Screenshots wurden angesehen. Berichte unter
`/tmp/fvrc1008-terminal-drain-{personal,team}-conflict-report/index.html`.
Die Browser laufen im Default ohne Ownership; sie prüfen Regression, nicht den
neuen optionalen Handoff. Dessen Belege stehen in den getrennten Servertests.

Auch der gewöhnliche Zehnerfall besteht: Personal **55,2 s**, Team **54,2 s**.
Zehn unabhängige `edit_file`-Vorschläge, drei Einzelannahmen und sieben gemeinsam
erhalten den exakten Endtext und erzeugen genau vier neue Inhaltsrevisionen.
Wiederholungen sind idempotent; veränderte Wiederholungsaufträge werden abgelehnt.
Die Screenshots zeigen null offene Reviews und fünf Versionen einschließlich
Import. Berichte: `/tmp/fvrc1008-terminal-drain-{personal,team}-batch-report/`.
Alle vier Läufe liefen seriell mit einem Worker und mindestens 55 Sekunden
Abstand nach bestätigtem Abschluss. Sie liefen vor der abschließenden Ergänzung
des Guards gegen bereits laufendes Normal-Unload; dieser ist im Default-Bootstrap
inaktiv und wird separat im tatsächlichen optionalen Serverpfad geprüft.

Der letzte GitNexus-Scan des Teil-Commits umfasst zwölf Dateien / 165 Symbole /
keine indexierten Prozessketten, LOW. Der Gesamtbranch gegen `main` bleibt mit
266 Dateien / 30 betroffenen Prozessketten CRITICAL. Diese Teilabnahme ist keine
Mergefreigabe. Keine Dependency-Version und kein Lockfile wurden geändert.

## Weiterhin offen

Der reguläre Bootstrap aktiviert Ownership weiterhin **nicht**. Kein
Produkt-Lifecycle-Writer ruft den neuen lokalen Drain bislang auf. Insbesondere
leere oder noch ladende Räume werden nicht als erfolgreich freigegeben gemeldet.

Vor Aktivierung folgen dauerhafte prozessübergreifende Admission-Reservation,
Entzugsbenachrichtigung und Advisory-Guard bis zum Lifecycle-Commit, Behandlung
aller Binärschreiber sowie ein Mixed-Version-Gate. Der lokale Drain ist keine
Autorisierung für einen späteren Rename/Restore/Delete. Ebenso offen bleiben
atomarer Kandidatencommit vor Live-Publish, Crash-/Reconnect-Abnahme, komplette
PG-/MR-Matrix und der manuelle Konflikteditor P12. Keine Container wurden für
diesen Baustein neu gebaut, kein Feature-Gate geöffnet, kein Push ausgeführt.

Der unabhängige Review fand keinen HIGH-/CRITICAL-Blocker im begrenzten lokalen
Pfad. Bewusste offene Verfügbarkeitsgrenzen bleiben: Ein Fehler nach positivem
Receipt, aber vor erfolgreichem Unload/Finish, benötigt eine gesonderte
Wiederaufnahme-/Restart-Recovery. Eine nie zurückkehrende Auth-/Load-Abhängigkeit
wird nicht künstlich für beendet erklärt. Die prozesslokale Drainer-Registry
setzt genau eine aktive Collaboration-Serverinstanz pro Prozess voraus.

Nächster verpflichtender Schritt vor Produktanbindung: dauerhafte Admission-
Reservation vor dem Workspace-Lock erwerben, den tatsächlichen Owner zum Drain
auffordern und dessen Receipt unter demselben Advisory-Guard bis zum
Lifecycle-Commit prüfen. Leere/laufend ladende Räume und der Absturz zwischen
Receipt und lokalem Unload benötigen ausdrückliche Recovery-Zustände. Erst
danach dürfen Rename/Restore/Delete auf den neuen Handler umgestellt werden;
Abnahme mit zwei Prozessen muss erfolgreiche Weiterarbeit und Reconnect beweisen,
nicht ausschließlich die sichere Verweigerung alter Writes.
