# API-Zugang: einzelne Abnahmebelege vom 07.11.2026

Dieser Abgleich präzisiert Abschnitt 5b des
[Gesamtplans](../document-write-database-performance-plan.md). Er schließt die
Zuordnung der unten genannten API-Key-Verwaltungs-, Authentifizierungs- und
Lesegrenzen ab. Er erklärt nicht die gesamte API-/SDK-Matrix für abgeschlossen.
Review Center und Dateioperationen-Undo sind außerhalb des Umfangs.

## Herkunft und Prüfschicht

Der erfolgreiche [PR-CI-Lauf 42347995566](https://github.com/canvascoding/canvas-notebook/actions/runs/42347995566)
prüft `d39ccba0966a7f9f060ed2d61222a0450587a1af`. Der Merge von PR #231,
`505db489b639d52d8d208195873e04d20483d712`, hat denselben vollständigen Git-Baum.
Der nachfolgende Main-Lauf ist ein eigener, noch separat zu beobachtender Lauf.

Die [maschinelle Zuordnung](document-api-auth-case-evidence-2026-11-07.json)
enthält 28 Fälle mit Quellpfad, Zeile, SHA-256 und tatsächlich vorhandenem
Erfolgsbeleg aus `native-api.log`. Die vier zugeordneten Quelldateien wurden
bytegleich gegen den geprüften CI-Commit verglichen. Der vollständige Log-Hash
bindet die Zuordnung an das heruntergeladene CI-Artefakt. Keine Credentials,
privaten Datenbankadressen oder absoluten lokalen Artefaktpfade werden übernommen.

Die Fälle verwenden echtes PostgreSQL, tatsächlich ausgestellte Credentials und
die reguläre Better-Auth-Sitzungsprüfung. Die HTTP-Fälle rufen die wirklichen
Route-Handler mit Request-/Response-Objekten auf. Sie beweisen keine zusätzliche
kompilierte Next.js-/TCP-Abnahme. Principal- und Servicefälle sind gesonderte
Schichten; ihre Ergebnisse werden nicht als zusätzliche HTTP-Requests gezählt.
Die beiden Serviceprüfer melden ihren Erfolg erst nach allen Assertions; sie
geben keine separaten Erfolgsereignisse je einzelner Assertion aus. Das JSON
kennzeichnet dies ausdrücklich mit `individualCaseLog: false`.

## Zugeordnete Grenzen

| Bereich | Tatsächlich ausgeführte Kontrolle | Schicht |
| --- | --- | --- |
| Gleichzeitige Ausstellung | Gleiche Request-ID erzeugt genau einen gespeicherten Schlüssel; zweiter Aufruf wird abgewiesen. | PostgreSQL/Service |
| Gleichzeitige Verwaltung | Zwei veraltete Editoren haben genau einen Gewinner; konkurrierende Rotationen hinterlassen genau einen aktiven Schlüssel. | PostgreSQL/Service |
| Verlorene Ausstellung/Rotation | Fehler nach tatsächlichem COMMIT; Abgleich über ursprüngliche Request-ID, keine neue blinde Ausstellung; verlorener Schlüssel gezielt widerrufbar. | PostgreSQL/Service |
| Datenbankfehler bei Rotation | Echte Constraint-Ablehnung rollt den Widerruf des bisherigen Schlüssels zurück. | PostgreSQL/Service |
| Credential-Lebensdauer | Rotation, Widerruf und Ablauf verweigern alten Zugang; Browser-Logout allein beendet programmatischen Zugriff nicht. | PostgreSQL/Service und Principal |
| Gemischte Credentials | API-Key plus Bearer oder Auth-Cookie abgewiesen; kein Fallback auf die gültige Sitzung. Reine Sitzungsanfrage bleibt erfolgreich. | Service und Route-Handler |
| Konto und Instanz | Gesperrtes Konto und fremde Instanz verweigert; keine serialisierte oder kopierte Principal-Struktur autorisiert einen Aufruf. | PostgreSQL/Service und Principal |
| Aktuelle Rechte | Seat-Suspendierung, archivierter Workspace, entfernte Aktion und fremder Workspace abgewiesen. Zusätzliche Benutzer-Schreibrechte erweitern einen Leseprincipal nicht. | Principal; Seat/Aktion/Workspace zusätzlich Route-Handler |
| Laufender Widerruf | Unabhängige PostgreSQL-Verbindung wartet nachweislich am gehaltenen Credential-Lock; nächste Principal-Phase verweigert widerrufenen Schlüssel. | PostgreSQL/Principal |
| Transaktionsgrenzen | Gleicher Backend/XID; ersetzte, fehlende und Read-only-Transaktion sowie Reentranz fail-closed. | PostgreSQL/Principal |
| Native Reads | Dokument-ID, Lineage, Workspace und vollständige Version; Unicode über mehrere Byte-Seiten exakt zusammengesetzt. | Route-Handler |
| Cursor und Suche | Rotation innerhalb derselben Integration erhält Cursor; fremde Integration erhält 409; Suche liefert zehn eindeutige native Identitäten mit aktuellen Versionen. | Route-Handler |
| Fehler und Limits | Sanitized 403; tatsächliche 401 nach Widerruf; 429 mit Retry-After zwischen einer und 60 Sekunden. | Route-Handler |
| Authentifizierungsbudget | Warme Eingangsprüfung benötigt fünf SQL-Statements; wiederholte innere Prüfungen schreiben Nutzungsstatistik nicht erneut. | PostgreSQL/Service |
| Datenerhalt | Lese-/Principalprüfungen vergleichen die ursprünglichen Dokument-/Yjs-Snapshots unverändert. | PostgreSQL |

## Verbleibende Matrixarbeit

### Ergänzte HTTP-Grenzen

Nach diesem CI-Abgleich wurden zwei dort noch nicht vorhandene Fälle ergänzt:
Kontosperre und Workspace-Archivierung zwischen zwei versionierten Leseseiten.
Beide prüfen tatsächliche 403-Antworten für Read und Search. Anschließend wird
der ursprüngliche Cursor nach regulärer Wiederherstellung der aktuellen Rechte
mit derselben Dokument-ID, Version und dem richtigen Byteoffset fortgesetzt.
Der abschließende Snapshotvergleich schützt die ursprünglichen Dokument-/Yjs-Daten.

Der gezielte lokale Lauf besteht alle acht HTTP-/PostgreSQL-Gruppen. Der
[separate lokale Bericht](document-api-read-current-access-2026-11-07.json)
bindet die geänderte Testquelle und den tatsächlichen Log per SHA-256, einschließlich
Schema-, Client-, Datei- und Bundle-Bereinigung. ESLint und die gezielte
TypeScript-Prüfung bestehen. Die neue Quelle ist noch nicht Bestandteil des oben
genannten CI-Laufs; dessen sechs ursprüngliche HTTP-Gruppen bleiben historische
Belege. Dieser Lauf benötigt weder einen Container-Build noch eine UI-Abnahme,
weil ausschließlich bestehende API-Tests erweitert wurden.

### Registrierter Agent-/MCP-Schreibpfad

Der gezielte aktuelle Lauf von
`scripts/native-document-edit-tool-dispatch-postgres-test.ts` besteht neun
Gruppen. Die [Einzelfallzuordnung](native-agent-mcp-edit-evidence-2026-11-07.json)
bindet Quelle, Log und Bereinigung: tatsächliche moderne MCP-Registrierung,
Pi-Registry inklusive Argumentprüfung und Wrapper, nativer XML-Edit über einen
echten PostgreSQL-Room-Owner, reine Statusabfragen, ursprüngliche Operations-ID
bei erneuerter Sitzung, Stale-Konflikte und aktuelle Scope-/Session-/Tool-/Grant-
Verweigerung. Die bereits vorhandene Suite war nicht im Native-API-/SDK-Workflow
registriert und erhält dort nun einen eigenen Schritt mit archiviertem Log.
Dieser Quelllauf ist keine kompilierte Browser-/OAuth- oder OS-Sandbox-Abnahme.

### SDK-Speicherverträge und übrige Matrix

Die neue `test_credential_storage.py` ergänzt sechs mechanische Vertragsfälle am
installierten veröffentlichten Wheel auf Python 3.10: unsichere/Null-Backends ohne
I/O, fehlende Abhängigkeit, getrennte Endpoint-/Profil-/Registrierungsdaten,
fremde oder beschädigte Datensätze, UTF-8-Größengrenzen und fehlgeschlagene
Schreib-/Löschbestätigung ohne Klartext-Fallback. Auch Fehlerketten dürfen den
Test-Token nicht offenlegen. Alle sechs Fälle bestehen. Die bestehenden frischen
MCP-Installationsprofile entdecken diese Datei automatisch; Core-only verwendet
weiterhin ausschließlich seinen Import-Isolationstest. Das sind simulierte
Backendverträge, keine sechs zusätzlichen HTTP-/PostgreSQL-Gruppen und keine
Live-Abnahme von Windows Credential Locker, Secret Service oder KWallet.

Diese Zuordnung ersetzt weder die API-Key-UI-Fälle noch tatsächliche OAuth-/
MCP-Token-Ausstellung, OS-Keyring, Schreib-/Dateioperationen oder Restore.
Diese Nachweise müssen jeweils an ihre eigenen Quellen und Laufberichte gebunden
bleiben. Insbesondere ist der Widerrufs-Locktest kein Nachweis eines beliebigen
Rechteentzugs während jeder Schreibfamilie.

Die installierten SDK-Lesegrenzen aus PR #231 sind zusätzlich in
[SDK-Lesegrenzen](sdk-read-boundaries-2026-11-06.md) dokumentiert. Ihre vier Gruppen
bestehen in beiden Python-Lanes und separat am kompilierten Release 2026.11.7.1.
Das umfasst Versionswechsel zwischen Seiten sowie harte Seiten-/Bytebudgets;
die 28 hier erfassten Auth-Fälle werden dadurch nicht nochmals gezählt.
