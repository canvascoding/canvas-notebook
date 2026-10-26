# Plan: zentraler Dokument- und Linkservice

Stand: 26.10.2026. Ziel ist eine robuste und messbar schnelle gemeinsame Grundlage
für Dokumente, Linkpflege und Aktualisierungen aus Editor, Agenten, MCP und normalen
Dateioperationen. Review Center und Undo sind ausdrücklich außerhalb der Umsetzung.
Bestehende Daten und weiterhin erforderliche Speicherformate werden erhalten.

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
  Test auf 3.089 Anweisungen. Die instrumentierte Serviceoperation benötigt weiterhin
  8.480 Anweisungen, davon 5.954 in 229 Berechtigungsprüfungen. Die Messbereiche sind
  unterschiedlich; daraus wird keine prozentuale Gesamtverbesserung abgeleitet.
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

## Reihenfolge und abgeschlossene Arbeitspakete

Die folgenden Pakete werden nacheinander abgenommen. Ein Paket gilt erst mit seinem
Nachweis als abgeschlossen; erste Optimierungen sind noch keine fertige Einführung.

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
Deployment. Die zusätzlichen Performanceänderungen sind lokal und noch nicht
abschließend validiert. Diese Ausgangslage bleibt bei Umsetzung des Plans erhalten.
