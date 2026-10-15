# Public-Lesezugriffe ohne versteckte Kurzcodewrites

Stand: 16. Oktober 2026. Produkt-/Testcommit Root `43be59fe291b5d5733793b016dd5e7024b777209`, identisch übernommen als QA `6c94366ff018c195b151c5617b457e86ac918058`. Dies schließt die nachträgliche Kurzcode-Erzeugung beim Lesen. Die regulären Publicwriter und ihre Autorisierung sind damit noch nicht an den zentralen Writervertrag angeschlossen.

## Änderung und tatsächliche Gegenprobe

Im [Public-Service](../app/lib/public-sharing/public-file-shares.ts) rufen ausschließlich `listPublicFileShares`, `getPublicShareAnnotations` und `resolvePublicShareRow` den bisherigen Kurzcodewriter nicht mehr auf. Der vorhandene `shortPublicFilePath` verwendet für historische Zeilen ohne Kurzcode bereits die vollständige Token-URL. Vorhandene Kurzlinks bleiben gültig. Die explizite Create-Wiederverwendung darf weiterhin einen Kurzcode vergeben; gewöhnliche Tokenzugriffe erhöhen weiterhin ihren vorhandenen Zugriffszähler. `recordAccess:false` und HEAD erhöhen ihn nicht.

Die neue [echte PG18-Fixture](../scripts/public-share-read-only-postgres-test.ts) erzeugt pro Leseeinstieg eine eigene historische Freigabe ohne Kurzcode. Ein tatsächlicher Statementtrigger auf `public_file_shares` und eine nichttransaktionale Sequenz erkennen auch Zero-row- und zurückgerollte Schreibversuche. Zusätzlich wird die vollständige gespeicherte Freigabe vor und nach jedem Read verglichen. Die tatsächliche File-Route führt HEAD aus; kein nachgebauter Routenersatz.

Der finale unveränderte Test scheitert gegen den ursprünglichen Produktstand `09938719f` beim ersten Listread mit Child-Exit **1**: `attemptedWrite:true`, ein bestätigtes Schreibstatement und `rowChanged:true`. Nach Wiederherstellung des korrigierten Produktstands bestehen alle **12 Fälle**, Child-Exit **0**, mit ausdrücklicher SQL-Abschluss- und nachfolgender Cleanup-/Finalmeldung. Der Harness beendet die tatsächliche RED/GREEN-Sequenz mit Exit **0**, Session `37138`. In beiden Childläufen sind eigenes Schema und DATA entfernt; null offene Clients.

Die zwölf Fälle umfassen:

- Je eigene historische Null-Code-Freigabe für Liste, Annotationen, Einzelansicht, Token mit `recordAccess:false` und HEAD: richtige vollständige URL beziehungsweise Route und kein Schreibversuch.
- Vorhandener Kurzcode bleibt ohne Mutation auflösbar.
- Ausdrückliche Create-Wiederverwendung vergibt genau einen Kurzcode per UPDATE; neue Erstellung erzeugt einen Kurzcode, normaler Tokenzugriff zählt genau einmal.
- Abgelaufene, widerrufene, fehlende und durch andere Datei ersetzte Ziele werden jeweils über Liste, Einzelansicht, Annotationen, Token und HEAD richtig behandelt. Die abgeleiteten Statuswerte werden nicht als neue dauerhafte Policy gespeichert.

## Testfehler und getrennte Bestandsgrenzen

Die ersten beiden eigenen GREEN-Versuche endeten tatsächlich nach sechs bestandenen Fällen mit Exit **1**. Der zusätzliche Create-Reuse-Fall erwartete ein UPDATE, zeigte aber im Testbeleg fälschlich ein früheres INSERT. Ursache war ausschließlich die neue Auditabfrage: `SELECT attempt::text ... ORDER BY attempt` sortierte den Ausgabealias lexikografisch. Ab Beleg 10 stimmte die letzte Position nicht mehr mit der letzten Schreiboperation überein. Die finale Abfrage sortiert ausdrücklich nach der qualifizierten numerischen Spalte. Keine Produktänderung und keine schwächere Assertion waren dafür erforderlich. Beide fehlgeschlagenen Versuche samt REDs und tatsächlichem Ressourcenabschluss bleiben erhalten.

Die älteren PGlite-Public-Lifecycle-/Workspace-Skripte endeten in drei frischen Starts mit Prozess-Exit 0, erreichten jedoch ihre eigenen Erfolgszeilen und ihren normalen DATA-Abschluss nicht. Sie zählen daher nicht als vollständige Regression. Die drei genau zu diesen Starts gehörenden generierten DATA-Verzeichnisse wurden anschließend anhand von Zeit, Eigentümer, Inode und begrenztem Inhalt identifiziert, entfernt und auf Abwesenheit geprüft. Die zuvor zu breit formulierte Bewertung ist im [Speichernachweis](./yjs-public-share-binding-evidence.md#validierung-und-ressourcenabschluss) eingegrenzt. Die Ursache des alten Harnessverhaltens bleibt offen; für den vollständigen Publicabschluss ist eine tatsächlich abgeschlossene breite Regression weiterhin erforderlich.

## Finale Prüfungen und Umfang

Cachefreies vollständiges TypeScript, Session `98775`, Exit 0; Scoped ESLint beider Produkt-/Testdateien, Session `21225`, Exit 0. Beide laufen nach der letzten Quelländerung. Produkt und Test stimmen anschließend mit den finalen RED/GREEN-Pins überein:

```text
public-file-shares.ts                  bdcc466e1bef561ba9214ddb6945cdec2bf951bb214963226cc49addf77c553e
public-share-read-only-postgres-test   63870a19497a4b94512823bacf0dc1541a1a7a3b6740e49ac68a0c607925e9f8
```

Vor dem Edit meldete GitNexus für den Resolver **HIGH** mit zwei direkten Aufrufern und 17 Symbolen bis Tiefe 3; die Warnung wurde vor der Änderung ausgesprochen. Direkte Aufrufer sind Token- und Kurzcode-Resolver; nachgelagert sind Vorschau, Download, Markdownassets und Exporte. Liste und Annotationen wurden ebenfalls separat geprüft. Staged `detect_changes` auf Root und QA meldet MEDIUM, zwei Dateien, exakt drei geänderte Produktfunktionen und vier indizierte Abläufe. Der unabhängige ASTvergleich bestätigt genau diese drei Funktionen; 58 andere Top-Level-Funktionen bleiben unverändert.

Das private Belegpaket enthält 23 kopierte Originaldateien einschließlich aller drei RED/GREEN-Sequenzen, echter Exits, finaler Quellpins, ASTvergleich, TypeScript-/Lintlogs und DATA-Abschluss. Manifest: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-public-read-evidence-g9xcjwr9/manifest.json`, SHA `15a0a27f5b9b9c198a6790f115b61bb09288f16dfaf50ac972430af43e845413`; Verzeichnis/Dateien 0700/0600. Keine ENV-Werte oder echten Nutzerdokumente wurden kopiert.

Dies ist eine lokale Service-/SQL-/HEAD-Abnahme, kein neuer Browserlauf. Es wurden weder Apphost noch Container gestartet. Public Create/Policy/Revoke, atomarer Accesswriter mit aktueller Publicautorität, native Reads, Owned-Lifecyclehooks sowie Lock- und vollständige Datei-/Linkkoordination bleiben offen. Die allgemeine native Aktivierung bleibt aus. API-/SDK-/Standard-Skill-/PDF-Auslieferung und die abschließende integrierte E2E-Abnahme folgen dem [zentralen Anschlussplan](./central-notebook-file-api-import-plan.md). Review Center bleibt ausgeschaltet.
