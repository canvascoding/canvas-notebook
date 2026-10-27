# Plan: zentraler Dokument- und Linkservice

Stand: 27.10.2026. Ziel ist eine robuste und messbar schnelle gemeinsame Grundlage
für Dokumente, Linkpflege und Aktualisierungen aus Editor, Agenten, MCP und normalen
Dateioperationen. Review Center und Undo sind ausdrücklich außerhalb der Umsetzung.
Bestehende Daten und weiterhin erforderliche Speicherformate werden erhalten.

## Priorität und Umsetzungspakete

Die Linkpflege ist eine zentrale Produktfunktion. Ein gemeinsamer Service bedeutet
hier gemeinsame Verträge und wiederverwendete Mechanik für alle Aufrufer; er
erfordert zunächst keinen weiteren laufenden Dienst. Der bestehende Dokumentleser,
die Quellenbeobachtung und die native Persistenz sind die Ausgangspunkte.

Die nächste Umsetzung folgt dieser Reihenfolge. Jedes Paket wird mit seinem
Abnahmekriterium abgeschlossen, bevor das abhängige Paket beginnt. Die bereits
vorhandenen Teiloptimierungen gelten nicht als Abnahme eines ganzen Pakets.

| Paket | Konkrete Änderung | Abnahme |
| --- | --- | --- |
| 0. Quellenfehler zuverlässig behandeln | Dokumentbezogene Ausfälle im lesenden Index eingrenzen; globale Autoritätsfehler weiterhin als solche behandeln. | Eine nachweislich einzelne fehlerhafte Quelle entfernt keine anderen geprüften Dokumente. Diagnose nennt die Quelle; nach Wiederherstellung verschwindet sie. Schreibprüfungen bleiben streng. |
| 1. Messung und Verträge vervollständigen | Editor einschließlich Zutritt und Projektion, Agent, MCP sowie öffentliche Rename-/Move-Abläufe mit derselben Instrumentierung messen. | Vergleichbare Berichte für kalt/warm und kleine/größere Workspaces; direkte Owner-Verbindungen sind enthalten; dominante Abfragegruppen stehen fest. |
| 2. Datenbankzugriffe bündeln | Aktuelle Berechtigungs-, Registry- und Zustandsdaten pro notwendiger Phase gemeinsam lesen und dieselbe Verbindung verwenden. | Weniger Abfragen und Pool-Ausleihen; echte Widerrufs-, Seat-, Realm- und Parallelitätstests bestehen unverändert. |
| 3. Linkprojektion inkrementell machen | Versionierte Extraktion je Dokument und gezielte Neuauflösung abhängiger Ziele; vollständigen Neuaufbau erhalten. | Ein Save inspiziert nur die geänderte Quelle. Rename, Move, Titel, Aliase und neue Ziele korrigieren alle betroffenen Links. Ergebnisse entsprechen dem Neuaufbau. |
| 4. Schreibwege vereinheitlichen | Bestehende Speicherung, Versionsprüfung und dauerhafte Belege hinter kleinen gemeinsamen Operationen verwenden; Aufrufer einzeln umstellen. | Editor, Agent und MCP liefern gleiche Speicher- und Linkergebnisse. Gleichzeitige Änderungen, Wiederholungen und Abbruch verlieren keine Daten. |
| 5. Einführung absichern | Endgültige Leistungsbudgets, reguläre Gesamtsuite, Desktop/Mobil, PR/CI/Reviews, Backup-/Restore-Nachweis und kontrolliertes Release. | Alle tatsächlich umgestellten Abläufe sind nachgewiesen; nach Deployment funktionieren Filetree, Öffnen, Speichern und Linkpflege in allen fünf Workspaces. |

Paket 0 adressiert einen konkret reproduzierten Fehler: Im isolierten UI-/API-Test führte ein
gezielt erzeugter Katalog-/Native-Zustandskonflikt bei `unavailable.md` zu null
Indexdokumenten und einer globalen Diagnose, obwohl andere Quellen lesbar waren.
Die originale Testquelle wurde feld- und bytegenau wiederhergestellt; der reale
Index lieferte danach wieder sechs Dokumente und drei Backlinks zum Testziel.
Die Korrektur ist lokal umgesetzt und mit einem echten PostgreSQL-Vergleich sowie
der gebauten Desktop-/Mobiloberfläche geprüft: Inaktive Zustände und beschädigte
native Bytes lassen die übrigen geprüften Dokumente verfügbar. Ein globaler
Organisationskonflikt verwirft weiterhin den ganzen Index; der Standardleser für
Mutationseingänge bleibt streng. Der [Prüfbericht](architecture/document-link-source-isolation-2026-10-26.md)
beschreibt die Abnahme einschließlich der feld- und bytegenauen Wiederherstellung.

Die gewünschte öffentliche Wirkung ist einheitlich: Ein erfolgreicher Save bestätigt
den gespeicherten nativen Stand; der abgeleitete Linkstand darf diesen nicht
überschreiben. Ein echter Versionskonflikt bleibt ein nachvollziehbarer Konflikt.
Wiederholungen dürfen anhand desselben dauerhaften Operationsbelegs fortsetzen,
statt eine Dokumentanlage oder Inhaltsänderung doppelt auszuführen.

## Befund und Ausgangszustand

- Der aktuelle Leser ist `app/lib/markdown/workspace-document-link-index.ts`.
  Die HTTP-Route und das Agentenwerkzeug für Dokumentbeziehungen verwenden ihn.
  Er beobachtet die Quellen über `workspace-source-authority-stage.ts`.
- Dateioperationen verwenden diese Quellengrundlage mit einer strengeren Prüfung.
  Native Linkänderungen werden über
  `app/lib/markdown/native-link-mutation-persistence.ts` gespeichert. Dort bestehen
  bereits Versionsprüfungen, Konflikterkennung und dauerhafte Änderungsbelege.
- Ein alter physischer Index/Umbenennungshelfer existiert ebenfalls. Die aktuelle
  Suche findet keine Produktaufrufer seiner exportierten Hauptfunktionen. Vor
  Entfernung müssen indirekte Aufrufer, Tests und Integrationen geprüft werden.
- Eine kleine neue Markdown-Datei verursachte im isolierten PostgreSQL-18-Test
  15.445 SQL-Anweisungen, davon 7.548 in einer Publikationstransaktion. Diese dauerte
  lokal 3,37 Sekunden. Kleine zusätzliche Antwortlatenz reproduzierte den Ablauf
  des Principals nach fünf Sekunden. In Produktion wurde auch ein PostgreSQL-
  Transaktions-Timeout protokolliert. Diese Messung gilt für die Agenten-Neuanlage;
  andere Abläufe brauchen eigene Messungen.
- Die erste lokale Optimierung reduzierte die größte Transaktion im verschachtelten
  Test auf 3.089 Anweisungen. Im danach vergleichbar gemessenen Create-Engine sank
  die SQL-Anzahl durch gebündelte Leser von 8.480 auf aktuell 6.452; davon liegen
  4.122 weiterhin in 229 Berechtigungsprüfungen. Die größte Transaktion dieses
  Messbereichs benötigt 2.337 Anweisungen. Das ursprüngliche vollständige Szenario
  mit 15.445 Anweisungen hat eine andere Messgrenze und ist damit nicht direkt
  vergleichbar. Die Zielbudgets sind weiterhin nicht erreicht.
  Die zwölf tatsächlichen PostgreSQL-Testgruppen für Agenten-Neuanlagen und die
  21 Fälle des gemeinsamen Dokumentlesers sind inzwischen erfolgreich. Ein zuvor
  beobachteter unerwarteter Netzwerkaufruf trat in den abschließenden Läufen nicht
  auf; die strenge Prüfung bleibt bestehen. Diese Teilergebnisse ersetzen weder
  die reguläre Gesamtsuite noch die Abnahme der nachstehenden Architektur.
- Der gemeinsame Dokumentleser besteht bereits in `app/lib/documents/service.ts`.
  Der Quellenleser lädt native Zustände bereits gebündelt mit zwei SQL-Abfragen
  je Prüfdurchlauf. Daher vorhandene Schnittstellen weiterentwickeln und die
  verbleibenden Wiederholungen messen, statt einen zusätzlichen Service daneben
  aufzubauen. Der normale Editor-Speicherpfad muss gesondert erfasst werden.

## Aktueller Messstand und verbleibende Bündelung

Der [aktuelle Create-Vergleich](architecture/document-service-create-matrix-current-2026-10-27.md)
am Produktstand `0a40365484806ea83d1e906d99406ff1445bde6b` besteht in allen 16 Fenstern
für Agent/MCP mit jeweils 10 und 200 regulär angelegten Quellen. Die warme
Agentenanlage benötigt 2.180 SQL-Treiberaufrufe / 46 Ausleihen, MCP 2.597 / 37;
die ursprüngliche Wiederholung 180 / 7 beziehungsweise 129 / 12. Identitäten,
Originalinhalt und vorherige Registry-/Lineage-/Native-/Metadatenzeilen/xmin sowie
physische Bytes bleiben geprüft; alle eigenen Ressourcen schließen vollständig.
Diese Werte sind innerhalb der jeweils gleichen Messgrenze vergleichbar.

Das ist ein abgeschlossener Messnachweis für Create, keine Abnahme von Paket 2
oder des Gesamtplans. Die [gemeinsame Member-Prüfung](architecture/document-service-member-current-2026-10-27.md)
liest aktuelle Sitzungs-, Konto-, Seat-, Workspace- und Kontextdaten inzwischen
in zwei statt acht frischen SQL-Aufrufen. Der tatsächliche 10-Quellen-Vergleich
reduziert warmes HTTP-Öffnen von 100 auf 88 Aufrufe und ein Editor-Leerlauffenster
von 1390 auf 1176; MCP-Neuanlage bleibt bei 2597. Die übrige gemeinsame Fakten-,
Registry- und Zustandsbündelung sowie abschließende Größen-/Latenzvergleiche
bleiben offen. Die [MCP-Faktenbündelung](architecture/document-service-mcp-slot-snapshot-2026-10-27.md)
reduziert inzwischen dessen aktuelle Slot-Prüfung von sechs auf drei Aufrufe;
mit tatsächlicher SQL-Planwiederverwendung sinkt warme MCP-Neuanlage bei zehn und
200 Quellen auf 1976 / 37. Die anschließend nachgewiesene NUMERIC-/JSON-
Abweichung ist nun mit [gemeinsamer exakter Wertübertragung](architecture/document-service-scalar-snapshots-2026-10-27.md)
auch in den Benutzer- und Agent-Create-Lesern lokal korrigiert. Agentenprofil- und
Sitzungsprüffelder verwenden dieselbe Mechanik; bestehende reine
Berechtigungsentscheidungen bleiben erhalten. Die Create-Budgets von wenigen Hundert Aufrufen, gemeinsame
Verträge, inkrementelle Links, normale gemeinsame Schreibwege und alle finalen
Recovery-/Build-/UI-/Suite-/Release-Gates bleiben erforderlich.

Die [gemeinsame Speicheraufruf-Phase für Agent und MCP](architecture/document-service-mcp-storage-phase-2026-10-27.md)
verwendet nun auch im MCP die vorhandene Transaktion bis zum Ende eines vollständigen
Helferaufrufs einschließlich seiner Bestätigungen. Die getrennten Aufrufe bleiben
frisch autorisiert; bestehende native Publikationsphasen behalten ihre Verbindung.
Der direkte Zehn-Quellen-Vergleich senkt warme MCP-Neuanlage weiter von 1976 / 37
auf 1871 / 33. Echte Sperren an ACKs, Rechteverlust vor der nächsten Phase und
verlustfreie explizite Wiederaufnahme nach zwei tatsächlichen COMMIT-Antwortverlusten
sind geprüft. Weitere Current-/Resolver- und Registry-/Zustandsbündelung bleibt nötig.

Die [zugeordneten Publikationsprüfungen](architecture/document-service-publication-boundaries-2026-10-27.md)
zeigen die dominanten Wiederholungen in MCP-Rechte-/Schema-, Lifecycle-Owner- und
Dokumentzustandslesern. Doppelte benachbarte Vollprüfungen sind innerhalb der
vorhandenen echten Phase entfernt; jede tatsächliche Publikationsgrenze behält
ihre vollständige native Prüfung. Der direkte Zehn-Quellen-Vergleich reduziert
warme MCP-Anlage von 1871 / 33 auf 1556 / 33 und
Agentenanlage von 2180 / 46 auf 2143 / 46.
Echte native Versionsrennen verweigern die Publikation; explizite Wiederholungen
erhalten Originalidentitäten und vollständige Bytes. Weitere Bündelung und alle
übrigen Abnahmen des Gesamtplans bleiben offen.

Die [gemeinsame frische native Beobachtung](architecture/document-service-native-observation-2026-10-27.md)
bündelt Receipt, Registry/Lineage-Beleg und nativen Zustand nach den unveränderten
strengen Katalogprüfungen. Am tatsächlichen Publikations-ACK sinken die betreffenden
Dokumentabfragen von sieben auf drei; sechs reale Zustandsfehler verweigern die
Publikation und explizite Wiederholungen erhalten Original-IDs und Bytes.
Der direkte Zehn-Quellen-Vergleich reduziert warme MCP-Anlage von
1556 / 33 auf 1404 / 33 und Agentenanlage von
2143 / 46 auf 1991 / 46. Die bisherigen
Validatoren bleiben gemeinsam verwendet. Weitere Bündelung und die übrigen
Abnahmen des Gesamtplans bleiben offen.

Die [gemeinsamen Owner-Fakten](architecture/document-service-owner-facts-2026-10-27.md)
lesen Verbindung, exklusive Sperre und Workspace-Zuordnung in einer frischen echten
Beobachtung. Die feste MCP-Quellenprüfung ersetzt nur ihre eigene doppelte
Owner-Lesung; Agenten behalten ihre separate Prüfung. Zwei reale Owner-Unlocks und
zwei Owner-Schemawechsel vor Veröffentlichung werden ohne Datenverlust abgewiesen;
explizite Wiederholungen behalten Original-ID und Inhalt. Der direkte Vergleich mit
zehn Quellen reduziert warme MCP-Anlage von 1404 / 33 auf
1312 / 33 und Agentenanlage von 1991 / 46 auf
1931 / 46. Weitere Bündelung und sämtliche übrigen Abnahmen des
Gesamtplans bleiben offen.

## Zielaufbau

Editor / Agent / MCP / Systemauftrag
→ jeweilige echte Authentifizierung und eng begrenzter Adapter
→ gemeinsamer Dokument- und Linkservice
→ aktuelle Berechtigungs- und Dokumentbeobachtung
→ vorhandene native Speicherung mit Versionsprüfung und Änderungsbeleg
→ abgeleitete Linkprojektion und gezielte Benachrichtigung.

Der Dienst bekommt getrennte, kleine Verantwortlichkeiten: aktuelle Daten lesen,
Links extrahieren und auflösen, eine Änderung vorbereiten, eine autorisierte
Änderung speichern und eine abgeleitete Projektion aktualisieren. Die Namen der
konkreten Schnittstellen werden bei Umsetzung festgelegt. Kein neuer großer
Controller und keine zweite Dokument-Wahrheit.

## Detaillierte Anforderungen und Abnahmekriterien

Die folgenden Pakete werden nacheinander abgenommen. Ein Paket gilt erst mit seinem
Nachweis als abgeschlossen; erste Optimierungen sind noch keine fertige Einführung.
Die aktuelle Aufrufkarte, abgegrenzte Messbereiche und offene Nachweise stehen in
[Aufrufer und Messbasis](architecture/document-service-database-baseline.md).

### 1. Aufrufer und Messbasis erfassen

Je einen reproduzierbaren Ablauf für Öffnen, Speichern, Agenten-/MCP-Neuanlage,
Backlinks und Umbenennen/Verschieben erfassen. Pro Aktion und Phase SQL-Anzahl,
Datenbankzeit, Gesamtdauer, Pool-Wartezeit und gleichzeitige Verbindungen messen.
Kalte/warme Aufrufe und kleine/große Workspaces getrennt vergleichen. Metriken
enthalten keine Inhalte, Pfade, Nutzeridentitäten, SQL-Parameter oder Secrets.

**Fertig:** Aufrufkarte, feste Testdaten, Messberichte und dominante Abfragegruppen.
Es darf keine Optimierung mit einer ungemessenen neuen Lesekette abgenommen werden.

### 2. Gemeinsame Verträge festlegen

Die echte Autorität bleibt beim nativen Dokumentzustand. Dokument-ID, Lineage,
Lebenszyklusgeneration, Sequenz, Zustandsbeleg und Parser-Version kennzeichnen eine
Beobachtung. Pfade und Titel dienen nicht als Ersatz für Dokumentidentität.
Gemeinsame Parser und Zielauflösung werden von den Integrationsadaptern verwendet.
Leseprofile und Prüfungen für Änderungen bleiben explizit unterscheidbar.

**Fertig:** Dieselben Eingaben liefern in Editor, Agent und MCP dieselben Links,
Zielentscheidungen und Diagnosen. Fehlende Zustände, Metadatenfehler, HTML-Grenzen
und unaufgelöste Ziele bleiben getrennt. Ein Lesecache kann keinen Schreibplan
oder eine Berechtigung erzeugen.

### 3. Berechtigungs- und Dokumentdaten bündeln

Für jede erforderliche Grenze aktuelle Benutzer-, Seat-, tatsächliche Sitzungs-,
Agenten-, Tool- und Workspace-Daten zusammen lesen. Bestehende Entscheidungslogik
wiederverwenden; keine Berechtigungen aus einem angenommenen Workspace herstellen.
Registry, Lineage, nativen Zustand und Projektionsstand gemeinsam und begrenzt laden.
Eine Beobachtung wird nur innerhalb ihrer konkret gehaltenen Phase verwendet.
Identität, Generation und Version werden vor dem Schreiben erneut geprüft.

Die Datenbankphase besitzt ihre Verbindung und Transaktion. Untergeordnete Dienste
öffnen dafür keine weiteren Verbindungen und wiederholen nicht dieselben vollständigen
Resolver unmittelbar hintereinander. Erforderliche Sperren, aktuelle Rechte,
Schema-/Relationsprüfung und bestehende Fristen bleiben erhalten. Der bestehende
allgemeine Rechteresolver wird nur schrittweise und nach Äquivalenztests umgestellt.
Vor der Umstellung wird explizit festgelegt, welche Änderungen innerhalb einer Phase
möglich sind und an welchen Grenzen eine neue Beobachtung zwingend erforderlich ist.
Eine gehaltene Verbindung allein ist kein Beleg für unveränderte Berechtigungen.

**Fertig:** Entzogene Rechte, gesperrte Accounts, fehlende Seats, archivierte
Sitzungen und geänderte Agenten-/Toolprofile werden auch unter Last abgewiesen.
Keine länger gültigen Principals und kein Berechtigungscache über Phasengrenzen.

### 4. Linkprojektion inkrementell aktualisieren

Die extrahierten Links werden pro Dokument mit dessen Versionsbeleg vorgehalten.
Beim Speichern wird nur das geänderte Dokument erneut extrahiert. Ein normaler
Backlink-Aufruf muss nicht erneut sämtliche Dateien lesen und Yjs-Zustände dekodieren.
Zunächst den begrenzten dokumentweisen Lesepfad umsetzen und messen; eine persistente
Projektionsablage nur mit nachgewiesenem Bedarf und eigenem kleinen Schema einführen.

Änderungen an Pfad, Titel und Aliasen invalidieren gezielt die davon abhängigen
Zielauflösungen. Auch bisher fehlende oder mehrdeutige Ziele müssen berücksichtigt
werden: Eine neue Datei kann einen alten Link reparieren oder mehrdeutig machen.
Verschobene Quellen benötigen eine neue Auflösung relativer Links. Dafür werden
Abhängigkeiten für exakte Pfade, Aliasnamen und Dateinamen ausdrücklich geführt.

Falls ein Hintergrundprojektor erforderlich ist, wird sein Auftrag atomar mit der
nativen Änderung gespeichert. Wiederholungen sind idempotent; ältere Aufträge dürfen
keinen neueren Stand überschreiben. Bestehende Produktbenachrichtigungen werden erst
nach bestätigtem Commit ausgelöst. Externe physische Dateiänderungen brauchen eine
Startup-/Abgleichstrategie; reine Browser-Invalidierung oder eine TTL reicht nicht.

**Fertig:** Einzeländerungen lösen keinen vollständigen Workspace-Neuaufbau aus.
Ein vollständiger Neuaufbau bleibt für Erstaufbau, Reparatur und Vergleich verfügbar.
Die Projektion ist jederzeit aus den maßgeblichen Quellen wiederherstellbar und
wird nie als alleinige Autorität für Schreiboperationen benutzt.

### 5. Normale Änderungen zentral ausführen

Editor, Agent und MCP delegieren die eigentliche Speicherung an dieselben
spezifischen Dienste. Ihre Authentifizierung bleibt jeweils echt und getrennt.
Vorhandene native Versionsprüfung und dauerhafte Belege werden weiterverwendet.
Parsing und Serialisierung finden außerhalb langer Schreibtransaktionen statt,
soweit das ohne Verlust einer notwendigen Sperre möglich ist. Jede Phasenteilung
braucht einen echten Abbruch-/Wiederholungsnachweis.

Bei Umbenennen und Verschieben werden die betroffenen eingehenden und relativen
Verweise vorab bestimmt und unter aktuellen Zustandsbelegen geändert. Mehrdeutige
oder nicht vollständig geprüfte Ziele dürfen keine stillen Umschreibungen erhalten.
Ein unsicherer COMMIT-Ausgang wird anhand dauerhafter Originalbelege aufgeklärt.
Ein unbestätigter Rollback wird nicht blind wiederholt.

**Fertig:** Kein Verlust von Inhalt, IDs, Lineage, Revisionen oder Freigaben bei
Parallelbearbeitung, Prozessabbruch, verlorener COMMIT-Antwort und Neustart.
Keine neue Review-Center- oder Undo-Implementierung als Voraussetzung.

### 6. Leistungsgrenzen und sichere Einführung

Nach der Bündelung verbleibende langsame Abfragen anhand tatsächlicher
`EXPLAIN (ANALYZE, BUFFERS)`-Pläne im isolierten repräsentativen Datenbestand prüfen.
Erst daraus zusätzliche Indizes ableiten. Vorläufige Entwurfsziele: höchstens fünf
SQL-Lesezugriffe pro aktueller Berechtigungsbeobachtung, höchstens zwanzig für ein
normales Dokumentöffnen und wenige Hundert für eine Neuanlage. Die endgültigen
Grenzen anhand des vollständigen Ablaufs festlegen, mit deutlichem Abstand zu den
bestehenden Zeitlimits und begrenzter Abhängigkeit von der Verzeichnistiefe.

Korrektheits- und Leistungstests umfassen echte PostgreSQL-Antwortlatenz, entzogene
Rechte, parallele Bearbeitung, fehlende Zustände, defekte Metadaten, HTML, Alias-
Konflikte, relative Links und neue Ziele für bisher unaufgelöste Verweise.
Desktop und Mobilansicht prüfen. Die vereinbarte reguläre Gesamtsuite muss grün sein;
Spezialumgebungen für Review Center und Undo werden dafür nicht neu aufgebaut.

Einführung in kleinen PRs: Messung/Verträge → gebündelte Leser → inkrementeller
Linkindex → gemeinsame Änderungspfade → kontrollierte Umschaltung und Bereinigung.
Neue Leseergebnisse zunächst mit dem bisherigen, vollständigen Neuaufbau vergleichen.
Die Umschaltung erfolgt pro Ablauf und mit Rückfall auf den vorherigen Codepfad.
Bei Datenänderungen bedeutet Rückfall nicht das Überschreiben neuerer Inhalte.

Die PR-Reihenfolge folgt den Abhängigkeiten: zuerst Messung und Verträge, danach
gebündelte Berechtigungs-/Dokumentleser, anschließend inkrementelle Linkprojektion,
danach die gemeinsamen Änderungspfade und abschließend Einführung/Bereinigung.
Jeder PR benennt seine tatsächlich umgestellten Aufrufer, Vorher-/Nachher-Messungen
und die noch offenen Abläufe. Der erste Leseumbau wird an einem einzigen Adapter
geprüft, bevor die übrigen Adapter folgen.

**Fertig:** Erforderliche CI-Prüfungen und umsetzbare Reviews abgeschlossen,
reguläre Gesamtsuite und UI grün, überprüfte Sicherung/Wiederherstellung vor
Produktionsmigration, danach Release, kontrolliertes Deployment und Prüfung aller
fünf Workspaces. Kein neues Release wird durch den Plan allein als fertig erklärt.

## Verhältnis zum bereits begonnenen Fehlerfix

Die Änderungen für Python-Umgebungen, erhaltene lesbare Quellen und getrennte
Indexdiagnosen sind bereits auf dem Fix-Branch committed. Die explizite, geprüfte
Wiederherstellung der sieben Altregistrierungen ist implementiert und lokal getestet;
die Produktionsreparatur benötigt noch die frische Backup-/Restore-Prüfung und das
Deployment. Ebenso muss die ursprüngliche unvollständige LinkedIn-Dokumentanlage
mit ihren vorhandenen Identitäts-, Inhalts- und Operationsbelegen verlustfrei
abgeschlossen werden; eine zweite Initialisierung ersetzt diese Wiederherstellung
nicht.

Die bisherigen Performanceänderungen sind auf `codex/fix-document-link-index`
committed und gepusht; PR #188 ist ein Entwurf. Am Stand `7edf640893` bestand die
reguläre Gesamtsuite mit 329 erfolgreichen Fällen, 268 bestehenden bedingten
Überspringungen und null Fehlern. Diese Überspringungen sind nicht ausschließlich
Review-Center-Tests. Die danach gefundene Layoutkorrektur für lange Diagnosepfade
und die Behandlung einzelner nativer Quellenfehler haben einen eigenen erfolgreichen
Produktionsbuild und tatsächliche Desktop-/Mobilprüfungen. Die reguläre Gesamtsuite
am endgültigen Stand bleibt ein Freigabekriterium. Der gesamte Serviceumbau ist
weiterhin nicht abgenommen; weder Merge auf
`main` noch ein neues Release oder Produktionsdeployment sind damit nachgewiesen.

Die [gemeinsame frische Bindungsbeobachtung](architecture/document-service-read-binding-2026-10-28.md)
bündelt Realm, Relationsauflösung und rohe Workspace-Felder an jeder unveränderten
Prüfstelle. Sechs erfolgreiche Kontrollen und fünfzehn echte Fehlerfälle über HTTP,
Agent und MCP erhalten Grenzen, Rollback und Originaldaten. Zehn PG-Suiten,
Release-/erweiterte TypeScript-Prüfung und ESLint bestehen. Zwölf echte getrennte
Fixtures mit 10/200 Dokumenten sparen in allen 18 Vergleichsfenstern jeweils zwölf
SQL-Aufrufe bei unveränderten Ausleihen. Normales warmes HTTP-Lesen sinkt von
88 auf 76 SQL-Aufrufe / 9 Ausleihen. Das finale Budget und alle übrigen Pakete
bleiben offen; dies ist keine Produktions-/Release-Abnahme.
