# YD-06: Reguläre Metadaten an die zentrale Schreibkoordination anschließen

Stand: 15. Oktober 2026. Dieser Anschluss betrifft `PATCH /api/files/metadata` für Titel, persönliche Favoriten und Pins. Die vollständige native Datei-/Linkkoordination, Gast-/Public-/Lockwriter und deren globales Ready-Gate bleiben eigene offene Aufgaben.

## Problem und Ergebnis

Der bisherige Endpunkt prüfte zuerst den physischen Pfad und schrieb Titel sowie persönliche Markierungen anschließend auf getrennten Datenbankverbindungen. Der Userstate-Writer las beide Werte und schrieb sie anschließend vollständig zurück. Dadurch konnten parallele Pin-/Favoritenänderungen unberührte Felder verlieren. Ein verspäteter Request hatte außerdem keine erwartete Dokumentidentität und konnte nach einer Pfadänderung auf eine Ersatzdatei treffen.

Der echte Endpunkt verwendet jetzt `updateWorkspaceFileMetadata`. Die alte frei aufrufbare Setterfamilie ist privat und benötigt die bereits gehaltene Connection. Ein vollständiger PATCH besitzt einen echten Request-Principal, eine Kernel-Sperre und eine einzelne READ-COMMITTED/READ-WRITE-Transaktion. Titel verlangt aktuelle Schreibrechte; persönliche Felder benötigen Leserechte und verwenden ausschließlich den aktuell authentisierten Nutzer. Rechte, Session und Workspace werden auf derselben Connection vor und nach dem Schreiben erneut geprüft.

Der aktuelle Clientvertrag lautet:

1. `GET /api/files/info?path=…` mit der gewählten Workspace-ID lesen.
2. Die tatsächlich zurückgegebene `data.metadataTarget` unverändert als `expectedTarget` zusammen mit `path` und den gewünschten Metadatenfeldern senden.
3. Bei einem Konflikt erneut lesen. Ein unbestätigter COMMIT erhält `503 FILE_METADATA_COMMIT_UNCONFIRMED`; der Service wiederholt den Request nicht und behauptet keinen Erfolg anhand einer ähnlichen aktuellen Zeile.

Die Referenz besitzt Version 1, Workspace und exakten Pfad. Native Ziele enthalten Dokument-ID und Lifecyclegeneration. Lineage, Repräsentation und Schema ergänzt der Server aus dem aktuellen SQL-Zustand; der vorhandene Shared-Writer-Fence prüft sämtliche Bindungen und Admissionreservierungen. Inhaltssequenz, Markdownexport und Freigabe des aktiven Room-Owners sind dafür nicht erforderlich.

Physische Ziele enthalten den Typ und die tatsächlich gelesene `dev:ino:size:mtimeMs:ctimeMs`-Version. Unter Kernel → Shared-Admission-Sperre werden Katalogautorität, Pfadreservierungen, Aliasfreiheit, ein offen gehaltener Dateideskriptor und aktuelle Pfadstatistik vor und nach dem Schreiben geprüft. Initialisierte oder unbestätigte native Autorität erlaubt keinen physischen Fallback. Native Kinddokumente machen einen physischen Ordner nicht selbst zum nativen Dokument. Physische Dateinamen mit äußeren Leerzeichen werden wegen des vorhandenen trimmenden physischen Resolvers mit Konflikt abgewiesen; native Namen behalten ihre exakte Schreibweise. Diese optimistische physische Vergleichsevidenz ist kein dauerhafter Namespace- oder Creationtoken.

Alle angefragten Felder schreiben gemeinsam oder rollen gemeinsam zurück. Die transaktionale Pfadsperre schützt auch eine fehlende persönliche Zeile; das partielle UPSERT erhält unberührte Spalten. Metadatenrelationen sind an das aktuelle Schema qualifiziert. Die bestehenden Lifecycle-Move/Delete-Metadaten sind eine andere Writerfamilie und bleiben unverändert. Ein gewöhnlicher PATCH innerhalb eines exklusiven Lifecyclecallbacks wird abgewiesen; eine Lock-Subwrite-Capability wird dafür nicht umgedeutet.

## Prüfung und Grenzen

Vor Änderungen zeigen die beiden alten Setter jeweils genau den Metadata-PATCH als direkten Produktcaller, LOW. Info-GET und PATCH sind einzeln LOW; der optionale `FileNode`-Typ hat dagegen CRITICAL-Reichweite mit 69 direkten und 970 insgesamt indexierten Abhängigkeiten. Diese Reichweite wurde vor der additiven Typänderung gemeldet. Ein Graphindex ersetzt keine Prüfung der tatsächlich gelesenen Quellen.

Der erste tatsächliche PostgreSQL-18-Lauf, Session 22899, endet mit Exit 0: 46 erhaltene Principal-Familien plus zehn neue Metadatenfamilien, insgesamt 56. Er verwendet die echten Better-Auth-Cookie-/Bearer-Anfragen, den normalen Runtimepool, tatsächliche Owner-/Admissiondienste und ein eigenes zufälliges Schema. Die vorherige Testumschreibung der Main-Agent-Migration ist entfernt; alle globalen DDL-Statements werden unverändert ausgeführt. Vier Partialpatch-Gegenfälle beobachten echte getrennte Backends und tatsächliche Pfadsperren. Eine verlorene Antwort wird erst nach tatsächlich erfolgreichem COMMIT injiziert; Discard, Backendabschluss und genau eine Mutation werden geprüft. Das ist ein SQL-/Servicebeleg, kein Produktions- oder Browserbeleg.

Nach diesem ersten Lauf ergänzte die unabhängige Prüfung strikte primitive Zieltypen sowie die unbestätigte COMMIT-/Close-/Discardgrenze. Eine neue Browser-Spec prüft den tatsächlichen App-Endpunkt mit aktivem nativen UI-Editor, unverändertem dauerhaftem Rich-Zustand, Favoriten-/Titel-/Pinanzeige und Reload; daneben einen echten veralteten physischen Versionsbeleg nach dem normalen Write-Endpunkt. Die native negative Browserprobe ist ausdrücklich ein Generationsmismatch, keine vollständige Move-/Recreate-Abnahme.

Der abschließende echte PG18-Lauf auf den korrigierten Quellen endet als Session 40273 mit Exit 0: alle 58 Familien bestehen, einschließlich der drei Array-Zieltypen und drei getrennten COMMIT-/Releasevarianten. Beide tatsächlichen Discards belegen Backendabschluss; beim normalen erfolgreichen Poolrelease mit anschließendem Fixturefehler wird der zurückgegebene Backend erst durch das reguläre `pool.end()` der Fixture geschlossen. Eine Poolrückgabe wird nicht als sofortiger Backendabschluss ausgegeben. Service-SHA-256 `8dc76c02184378ca2683ff65e29164788a3231085bba4b54f96cde0252542dcc`, Test `26e0fd8e2dc5e8e9625812e0f92d7ad2c82d725bc0b25509be6ddaf8fce9e0be`; diese Bytes bleiben vor/nach dem Lauf identisch. Privates Log: `/tmp/canvas-native-metadata-principal-postgres-final.log`.

Cachefreies vollständiges TypeScript (Session 88193), fokussiertes Lint (87013) und elf Info-Regressionen (14219) enden jeweils mit Exit 0. Eine frühere Lintdiagnose zum Fixture-Clienttracking ist durch eine Map tatsächlicher Clientobjekte behoben; keine Regel wurde deaktiviert. Der echte Browserlauf auf frischem Build steht an diesem Commit noch aus.

Allgemeine Nativeaktivierung, öffentliche SDK-/Standard-Skill-Veröffentlichung, vollständige Datei-/Linkoperationen und PDF-Anschluss sind dadurch nicht abgeschlossen. Es gibt keine Abnahme von Review-Center-Aktionen und keinen zusätzlichen Annahmeschritt für berechtigte Änderungen.
