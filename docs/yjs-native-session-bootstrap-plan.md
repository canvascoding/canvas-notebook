# Nativer Sessionbootstrap: bestehende Authority vor Projektion

Status: Sourceaudit abgeschlossen, Umsetzung und Aktivierung getrennt. Auditbasis `40c5a29d9`, zentrale Session-/Policy-/State-Dateien mit Root abgeglichen. Additive Foundation wird separat auf Root `d6bc8b78027ebacef31062b2f7dbf1f1a8886435` entwickelt. Keine Runtime-/Browser-Abnahme aus diesem Audit ableiten.

## 1. Belegter Fehler und Scope

- [Sessionservice](../app/lib/collaboration/session-service.ts), `createCollaborationSessionGrant`, Zeilen 160–164: `ensureDocument:true` kann Registry/Lineage bereits vor der Authority-Auswahl anlegen. Zeilen 205–215 lesen/analy­sieren Disk vor dem vorhandenen Yjs-State. Fehlende Projektion verhindert den Grant; stale Projektion beeinflusst das Rich-Migrationsziel.
- [State-Resolver](../app/lib/collaboration/document-state-service.ts), Zeilen 73–101: erneuter State-Load mit `existing ?? ensureCollaborationState`. Ein früherer Load plus `initialContent=''` verhindert deshalb keine Wiederinitialisierung nach verschwundenem State.
- [Persistenz](../app/lib/collaboration/persistence.ts), Zeilen 219–283: reale Writer-/Lifecycle-Admission ist vorhanden. Bei fehlendem State wird aber Registry-Marker/Historie vor dem INSERT nicht atomar als pristine bewiesen.
- [Parser](../app/lib/collaboration/session-service.ts), Zeile 105, und [Policy](../app/lib/files/collaboration-policy.ts), Pfadnormalisierung: `.trim()` kann bedeutungsvolle Namensspaces verändern. [WebSocket-Identitätsprüfung](../app/lib/collaboration/connection-access.ts), Zeilen 45–55, verwendet denselben Metadata-Reader.

Erster Scope: vorhandene native `.md`, `.markdown`, `.txt`, einschließlich fehlender/staler Projektion und gültigem, unexportierbarem Rich. Exakte kanonische Pfade erhalten. `.docx`, suffixunabhängige UI-/Providerwahl und Guest-Sharing separat. Die [Guest-Erstellung](../app/lib/file-guests/service.ts) besitzt zusätzliche physische Stat-/Markdown-Export-Voraussetzungen; ein Sessionfix schließt diese nicht.

## 2. Paket A: inaktive existing-only Foundation

Neue Dateien, keine bestehende Source-Aktivierung:

- `app/lib/collaboration/native-session-state-reader.ts`
- `scripts/native-session-state-reader-postgres-test.ts`

Geplante interne Exports:

- `withExistingNativeCollaborationSessionOnConnection(connection, {workspace,path,expectedIdentity?}, consume)`: Callback erhält eine private, Connection-/Backend-/TX-gebundene, nach Callback ungültige Capability. Caller besitzt `BEGIN READ COMMITTED READ ONLY`, COMMIT/ROLLBACK und Connection-Disposal. Foundation öffnet oder beendet keine Transaktion.
- `assertExistingNativeCollaborationSessionCurrentOnConnection(connection, capability)`: frischer Exact-Identity-Read unter derselben gehaltenen Shared-Admission-Fence unmittelbar vor Grantbildung; keine Initialisierung. Liefert einen contentfreien, validierten Session-Snapshot.
- `inspectExistingNativeCollaborationSessionOnConnection(connection, capability, inspect)`: interne synchrone Analyse des aus genau demselben Binary validierten nativen Snapshots; keine Markdown-Serialisierung, keine Rohbytes im Session-DTO.

Die tatsächliche bigint Admission-Fence, Backend, Searchpath und laufende Transaktion prüfen; kein boolesches Authority-Flag, kein nested Shared unter eigener exklusiver Fence. Exakte Registry + aktive Lineage + Workspace/Organisation/Pfad + State-Identität/Generation/Representation/Schema binden. Existierende Statebytes/Vector vor großen Allokationen begrenzen und strukturell prüfen. Missing/archived/replaced/quarantined/invalid ergibt benannten Konflikt; niemals Diskfallback oder Seed. Callback-/Detached-Fehler bleiben fatal, Capability erlischt auch bei Fehler. Normale neuere Inhaltssequenzen sind kein Lifecycle-Konflikt.

Vorhandene Seams wiederverwenden:

- [Admission-Key / kanonischer Pfad](../app/lib/collaboration/room-admission-contract.ts): `collaborationAdmissionLockKey`, `isCanonicalAdmissionPath`; spaces erhalten.
- [Same-Connection-State-Load](../app/lib/collaboration/persistence.ts): `loadCollaborationStateOnConnection`, Zeilen 191–203. Bounded Exact-File-Metadata-Read statt unbegrenzter Catalogue-Nachfahrenenumeration.
- [Nativer Snapshot](../app/lib/collaboration/document-snapshot.ts): `authoritativeNativeCollaborationSnapshot` / `inspectPersistedNativeCollaborationSnapshot`; Binary/Vector/raw schema/pending updates, keine Markdown-Exportpflicht.
- [Bestehender Reader](../app/lib/collaboration/workspace-search-reader.ts): Shared-Admission-Key und Same-Connection-State-Lader als Sourcebeleg; dessen Textflattening nicht als Sessionauthority verwenden.

Foundation besitzt keine aktuelle Principal-/Mutation-ACL und gewährt keine Room-Admission. Sie bleibt inaktiv. Spätere Sessionintegration prüft Rechte/Provider/Client-Capabilities und bildet Ticket erst nach frischem Identity-Nachweis. Kein öffentlicher Binary-/Native-Content-DTO.

## 3. Paket B: pristine-only Lazy-Erstinitialisierung

Erst nach geschlossenem Paket A separat entwickeln. Fehlender State ist allein kein Erstinitialisierungsbeweis. [Catalogue](../app/lib/collaboration/workspace-document-catalogue.ts), Zeilen 79–81: nur `never_initialized`, `state_version=0`, kein State und keine Historie ergibt pristine; sonst missing-state. Unregistrierte physische Datei braucht einen eigenen echten FS-Zielanspruch und Registry-Erstellungsbeleg.

Im selben tatsächlichen Lifecycle-/Admission-Mutationsfence Marker/Historie/Identity erneut prüfen, Originalbytes + FS-Fingerprint/NoFollow/Ancestor-Proof bestätigen und einmalig native State persistieren. Fatal UTF-8, BOM, CRLF, Frontmatter und tatsächliches Byteprofil erhalten; Mixed/Bare-CR oder ungültiges UTF-8 benannt ablehnen. Bestehende 5-MiB-Session-Erstinitialisierungsgrenze nicht versehentlich auf 8 MiB erweitern. [Vollimportcompiler](../app/lib/collaboration/markdown-file-import.ts) und [Importpersistenz](../app/lib/collaboration/markdown-file-import-persistence.ts) sind mögliche kontrollierte Seams, keine bereits aktivierte Bootstrap-Lösung. `.txt` Erstinitialisierung bleibt Plain; Rich-Format hängt von tatsächlichen Client-Capabilities ab.

Konkurrierende Initialisierung übernimmt nur den nachgewiesenen Gewinner und überschreibt ihn nie. Historisch initialisiert/verloren, `legacy_unknown`, Peer-Inhalt und unbekannter COMMIT erlauben keinen leeren Seed oder Rohdatei-Overwrite. Receipt-/Recovery- und Publication-Vertrag vor Aktivierung ausdrücklich schließen.

### 3.1 Nachtrag: tatsächliche Requestrechte und Transaktionsvertrag

Die auf `3a64e737d` integrierte [Request-Principal-Grundlage](../app/lib/workspaces/request-principal.ts) bindet tatsächliche Cookie-/Bearer-Sitzungen und aktuelle Rechte auf derselben RC/RW-Verbindung. Ihre echten Auth-/Predicate-Rowlocks brauchen diesen Transaktionsmodus. Der bestehende [native Session-Reader](../app/lib/collaboration/native-session-state-reader.ts) verlangt dagegen ausdrücklich RC READ ONLY; beide APIs können daher nicht direkt ineinander geschachtelt werden.

Der private native Readerkern besitzt inzwischen den gesonderten authentisierten Eingang `withAuthenticatedExistingNativeCollaborationSessionOnConnection`: ausschließlich eine von der echten Request-Factory erzeugte Principal-Capability, dieselbe RC/RW-Verbindung und frische Principalprüfung vor beziehungsweise nach den nativen Reads. Ein öffentlicher boolescher RW-/Auth-Bypass ist ausgeschlossen. Die ursprüngliche reine Read-only-API und ihre vorhandenen Negativtests bleiben erhalten. Native Identität, Shared-Admission, Raw-Schema, Quarantäne und Größenprüfung gelten auch im authentisierten Zweig; er besitzt weder Seed-, Mutations-, COMMIT- noch Room-/Ticketautorität. Root bestätigt nach bytegleicher Integration [24 echte Cookie-/Bearer-/PG18-Testgruppen](../scripts/authenticated-native-session-reader-postgres-test.ts), die unveränderten 20 RO- und 37 Principal-Gruppen, vollständiges TypeScript und fokussiertes ESLint. Beide Abschlussfenster, einschließlich der tatsächlichen letzten SQL-Prüfung des unveränderten Principal-Service nach Callbackende, weisen zurückbehaltene/falsche Capabilities fatal ab. Ein echter Roomowner persistiert während der Shared-Lesephase eine reine Löschung mit gleicher StateVector und neuem StateProof. Die Sessionroute bleibt unverändert und dieser Eingang inaktiv. Der separate Original-Bootstrap benötigt seine eigene exklusive A-Lease und verwendet diesen Shared-Reader nicht innerhalb der Erstinitialisierung.

## 4. Enge spätere Session-/Auth-Aktivierung

1. Native existing-only Zweig vor `getFileCollaborationState(ensureDocument:true)` und Diskread wählen. Existing Rich besitzt seine Darstellung; Block-Client und explizite Mismatches weiter prüfen.
2. Pristine/unregistered nur über Paket B; fehlende native Authority stets fail closed. Broad `resolveTextCollaborationState`/`ensureCollaborationState` nicht beiläufig verändern.
3. Rich-Migrationsanalyse aus validiertem nativem Zustand: Plain Body+Frontmatter aus demselben Binary; bestehendes Rich aus seiner Darstellung. Ohne sichere Analyse bleibt die Darstellung bestehen. Bestehende moderne Migration-/Recovery-Receipts erhalten; Legacy-Migrationskonflikt ausschließlich existing-only neu laden.
4. Parser und `assertCollaborationDocumentAccess` exakt-native Pfade/Identität verwenden. [Server](../server/collaboration-server.ts): aktuelle Sessionrechte, echte Room-Admission/Owner-Claim und erneuter State-Load nach Claim bleiben letzte Join-Autorität. Gewöhnliche aktive Rooms nicht wegen Sessionread stoppen.
5. Gültige nichtpermanente Projectionfehler verhindern native Bearbeitung nicht. Permanente Quarantäne nie löschen oder Schreibgrant erteilen; vorhandener Read-only-Diagnosevertrag separat prüfen. Projection-/Migrationstatus im Web-/Mobile-Wire erhalten, keine falsche Finalization.

## 5. Impact und Abnahme

GitNexus eigener aktueller Index; vor jeder tatsächlichen bestehenden Symboländerung erneut ausführen und HIGH/CRITICAL melden:

| Symbol | Risiko | Direkt / insgesamt | Betroffene Grenzen |
| --- | --- | --- | --- |
| createCollaborationSessionGrant | HIGH | 9 / 18 | Web, Mobile, Guest, Integration |
| parseCollaborationSessionRequest | MEDIUM | 8 / 16 | Sessionparser/Client-Verträge |
| assertCollaborationDocumentAccess | HIGH | 2 / 4 | Server, Mobile |
| resolveTextCollaborationState | CRITICAL | 4 / 34 | Agent/PDF und Sessionpfade |
| ensureCollaborationState | CRITICAL | 3 / 28 | Agent, Mobile, Server, Guest |
| readFileCollaborationState | CRITICAL | 13 / 53 | Metadata/Auth, Agent/PDF |
| getFileCollaborationState | CRITICAL | 23 / 80 | Create, Read, Agent/PDF |

| Fall | Erforderlicher Nachweis |
| --- | --- |
| Plain/XML/Blocks, leer seq0, Frontmatter-only, echte XML-Tombstones | Binary/Identität/Byteprofil erhalten, kein Init/Export/FSread |
| Projektion fehlt/stale/source-only; legaler Rich-colwidth-State | Native Grantfähigkeit unabhängig vom Markdown-Roundtrip |
| State verschwindet/Replacement/Move/Archivierung zwischen Reads | Benannter Konflikt ohne Ticket/Seed |
| Falsche org/Lineage/Gen/Schema; Binary/Vector/pending/raw attrs defekt | Fail closed, kein Fallback |
| Fremde Connection/TX/Backend, exclusive nesting, retained/forged/detached | Keine gültige Capability; Fehler dauerhaft fatal |
| Read-only/Rechteentzug, Blockclient-Mismatch, Quarantäne | Bestehende Rechte-/Formatgrenzen erhalten |
| Pristine UTF-8/BOM/CRLF/Frontmatter, konkurrierender Init | Echter atomarer Erstzustand; kein Peer-Overwrite |
| Web/Mobile Session → Ticket → wirklicher WS-Join | Aktuelle Session-/Roomauth und Owner-Reload bestätigt |

Vorhandene Testbausteine: [Native-Snapshot](../scripts/collaboration-native-snapshot-test.ts), [Empty-State](../scripts/collaboration-native-empty-state-test.ts), [Schema](../scripts/collaboration-native-schema-test.ts), [Agent-Integration](../scripts/file-agent-operation-integration-test.ts), [Block-Integration](../scripts/collaboration-block-format-integration-test.ts). [Mobile-Route-Test](../scripts/mobile-collaboration-session-route-test.ts) mockt den Grantservice und ist keine reale Bootstrap-Abnahme. [Lifecycle-E2E](../tests/collaboration-owned-file-lifecycle.spec.ts), `openRoom`, besitzt echten HTTP-Ticket/Hocuspocus-Anschluss; Checkpoint-Wartebedingung für absichtlich unexportierbare Native-Fixtures trennen. Reale Server-/UI-Abnahme bleibt eigene koordinierte Task nach Source-Aktivierung; keine parallelen Hosts/Container aus diesem Plan starten.
