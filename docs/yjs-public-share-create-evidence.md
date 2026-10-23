# Public Create/Reuse: Autorität und dauerhafte Zielbindung

Stand: 16. Oktober 2026. Produktcode Root `72e4b8f8f15ba2aa55bc6e835f8a5c554b28ba07`, identischer Anschluss in QA `c9e9109b632e57547dc2d754242ab5fa4339e3bd`. Dies schließt den Schreibanschluss ab; die vollständige native Public-Funktion bleibt wegen des unten beschriebenen Readers offen. Keine Veröffentlichung oder allgemeine Aktivierung.

## Verhalten

Der vorhandene Web-/Mobile-POST und das Agententool benutzen denselben Publication-Writer. Eine echte ursprüngliche Request-Anmeldung beziehungsweise die aktuelle `public_share_file`-Invocation bestimmt Workspace, Benutzer und Agent-/PI-Herkunft. Übergebene historische Actor-/Workspaceobjekte verleihen keine Rechte. Aktuelle Konto-, Seat-, Workspace-, Tool-, Consent- und Verwaltungsrechte werden auf der tatsächlichen SQL-Verbindung geprüft, auch bei unveränderter Wiederverwendung.

Ein gemeinsamer Workspace-Kernel bindet Vorbereitung und Veröffentlichung. Physische Dateien werden über den gehaltenen Dateideskriptor und genaue Metadaten geprüft. Native Dokumente verwenden ursprüngliche Dokument-/Lineage-/Generationspins, Admission und den vorhandenen Shared-Writer-Fence; der begrenzte persistierte Yjs-Zustand wird auf derselben Verbindung validiert. Dafür werden weder Markdown-Projektion noch lebender Editorraum angelegt. Die Suffixentscheidung kann native Autorität nicht überschreiben. `sizeKind: native-state` kennzeichnet die Größe des kodierten Zustands, keine exportierte Dateigröße.

Kompatible Freigaben behalten Token, Ursprungspins, Quelle, Passwort- und Zugriffsfelder. Ausgelassene Policyeinstellungen bleiben erhalten; eine Standardablaufzeit gilt nur bei Neuanlage. Alte Freigaben ohne Kurzcode erhalten diesen durch den expliziten Writer. Ersetzte oder abgelaufene Ziele werden mit neuer Identität und neuem Token veröffentlicht; alter Widerruf und neue Zeile sind eine Transaktion. Ein fehlgeschlagenes INSERT rollt den vorherigen Widerruf zurück. Dateinamen mit führenden oder abschließenden Leerzeichen bleiben exakt.

Zielbezogene Konflikte liefern pro Pfad `skipped`; Autorisierungs-, SQL- und unklare COMMIT-/Cleanupfehler sind fatal. Ein möglicher COMMIT wird weder als Erfolg noch als übersprungene Datei ausgegeben und nicht blind wiederholt. Zufällige Credentialkollisionen haben eine feste Versuchsgrenze; die tatsächlichen eindeutigen Indizes werden geprüft.

## Lokale Nachweise

Alle fünf SQL-Prozesse liefen nacheinander gegen PostgreSQL 18 mit eigenen migrierten Schemas und eigenen DATA-Verzeichnissen. Die Tests bestätigen vollständige Assertions, Schema-/DATA-Entfernung und null offene Clients; der tatsächliche Prozessabschluss ist jeweils Exit 0.

| Prüfung | Ergebnis |
| --- | --- |
| Create/Reuse, echte Cookie-/Bearer-/Agentautorität, Web-/Mobile-POST, Plain/XML/Blocks ohne Projektion, Wiederverwendung, Tokenwechsel, negative Rechte-/Ziel-/TEMP-/Triggerfälle und vier COMMIT-/Releasefehler | 46/46 |
| Borrowed Repository, CAS, echte Kollisionen und paralleles Entfernen eines eigenen eindeutigen Indexes | 37/37 |
| Unveränderte Policyregressionen nach gemeinsamer Capability-/FD-Extraktion | 65/65 |
| Unveränderte Widerrufsregressionen einschließlich aktueller Rechte auf derselben Verbindung | 60/60 |
| Migrierte Leseregressionen mit echtem Request für das Create-Setup; alte URL-/Kurzcode-/Read-only-Assertions erhalten | 12/12 |
| Vollständiges TypeScript ohne Incrementalcache; ESLint aller elf geänderten Dateien | Exit 0, keine Lintwarnungen |

Der Create-Fixturehash des bestandenen Laufs lautet `c52fb8037ecc8701ce15f61bd237bf1cf7389ba3cef2b415292f781d6e934ebb`. Zwei vorherige Läufe scheiterten nach 21 beziehungsweise 32 Gruppen an Fixturefehlern: Ein Spezialagent besaß eine ausdrückliche Toolüberschreibung; die korrigierte Prüfung belegt zuerst tatsächliche Vererbung. Der TEMP-Fall erwartete eine fatale Rejection statt des vorgesehenen pfadbezogenen Konflikts. Er prüft jetzt den exakten Fehlergrund, unveränderte Zeilen, null Schreibversuche und tatsächlichen Rollback; die Injektion bindet das wirkliche Transaktionssetup von Selection beziehungsweise Finalwriter. Diese Korrekturen ändern keine Produktprüfung oder zulässige Autorität.

Die neue Indexgruppe beobachtet reale Invalid-/Ready-/Live-Flags, den blockierten Peer, zwei echte INSERT-Versuche, fortbestehende Eindeutigkeit bis zum Ende der ursprünglichen Transaktion und anschließenden Abschluss/Wiederherstellung des eigenen Indexes. Dies entspricht dem [PG18-Vertrag für konkurrierendes Indexentfernen](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/access/heap/README.HOT). Eine zusätzliche globale Serialisierung wurde daraus nicht abgeleitet.

GitNexus meldet vor beiden Produktcommits elf Dateien, vier betroffene Prozesse und mittleres Risiko. Der partielle Index ordnet auch unveränderte Nachbarsymbole zu; ein zusätzlicher AST-Vergleich bestätigt die tatsächlich geänderten Funktionskörper. Insbesondere bleiben Native-Rawvalidator, `reconcileRow`, normale Pfadnormalisierung und Token-/Kurzcode-Reader unverändert. Neue Symbole sind teilweise nicht indexiert; UNKNOWN wurde nicht als Entwarnung verwendet.

Private Originalprotokolle und Quellenhashes: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-public-create-evidence-1xqq1bw0/manifest.json`, SHA-256 `f0e56b7fcc8e2189ccf3a9b90ec02fb0be7e188b21f1a7186ce2e4e692184879`. Kein Env, Token oder Recoverymanifest wird hier veröffentlicht.

## Offener Reader und nächste Abnahme

Nachfolgender Stand: Der [native Reader mit fokussierter Browserabnahme](./yjs-public-native-reader-evidence.md) ist inzwischen auf Root `94dd203c1` / QA `3582f5772` geprüft. Die folgenden Aussagen beschreiben die hier dokumentierte Create-Codebasis `72e4b8f8f`; automatische Lifecyclehooks und der physische Accesswriter bleiben weiterhin offen.

Create/Reuse bestätigt die gespeicherte Freigabe samt ursprünglicher Zielbindung. **Der bestehende native öffentliche URL-Pfad funktioniert damit noch nicht:** `reconcileRow`/`resolvePublicShareRow` und die Response-Consumer verlangen weiterhin eine physische Datei und deren Identität; native Zeilen verwenden absichtlich eine andere Zustandsidentität. Ein bestandener nativer INSERT ist deshalb kein bestandener öffentlicher Link. Der native Reader ist der unmittelbar folgende Anschluss derselben Public-Aufgabe und Voraussetzung ihrer vollständigen Abnahme.

Der Reader benötigt getrennte physische und native Ergebnisse, aktuelle anonyme Freigabeautorität, direkt darstellbaren nativen Inhalt sowie ausdrücklich geprüfte Exportbytes für Download/HEAD/Range. Historische all-NULL-Links dürfen nicht anhand eines inzwischen nativen Pfades umgebunden werden. Referenzierte Assets und Widerruf/Generation/Quarantäne gehören zur Anschlussmatrix. Accesscounter und automatische Owned-Lifecyclehooks bleiben ebenfalls offen. Dieser Schreibschritt enthält keinen neuen Produktionsbuild oder Browserlauf; die bisherige Policy-UI-Abnahme gilt nur für ihren damaligen Code. Abschließende integrierte E2E-Abnahme, allgemeines Ready-Gate, SDK/Standard-Skill, PDF und übrige Datei-/Linkkoordination bleiben offen. Das Review Center bleibt ausgeschaltet.

Der [Folgenachweis zu exakten Public- und Markdownpfaden](./yjs-public-share-exact-path-evidence.md) ergänzt die Leseselektoren und die tatsächlich getesteten Upload-/Öffnungs-/Metadata-Fälle. Die ursprüngliche Create-Abnahme wird dadurch nicht rückwirkend erweitert; Writer-/Lifecycle- und Gesamtabschluss bleiben gesondert.
