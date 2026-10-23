# Vorhandene native Yjs-Dokumente unabhängig vom Dateisuffix öffnen

Status: Anschlussplan; keine Produktaktivierung. Belegbasis ist der vorhandene Source inklusive native Sessionintegration `d361eded`. Änderungen am laufenden WS-Paket gehören nicht zu diesem Plan.

## Ziel und feste Grenze

Ein tatsächlich vorhandenes natives Yjs-Dokument soll im Webeditor anhand seiner aktuellen Identität und Darstellung geöffnet werden, auch wenn sein Pfad beispielsweise auf `.docx`, `.json` oder einen anderen Nicht-Markdown-Suffix endet. Plain bleibt Plain; XML und Blocks bleiben strukturierter nativer Inhalt. Eine echte Office-Datei ohne initialisierten Native-State bleibt im Office-Pfad.

Dieser Anschluss initialisiert keine Office-/Binärdatei als Yjs, importiert keine ZIP-/Officebytes, erzeugt keinen Ersatz-State aus einem Text-Export und erweitert keine Gastberechtigung. Ein Suffix oder Client-Datenfeld erteilt keine Read-/Write-Authority.

## Belegter Iststand

| Bereich | Vorhandener Pfad und Verhalten |
| --- | --- |
| Datei lesen | [`app/api/files/read/route.ts`](../app/api/files/read/route.ts) fragt `withNativeWorkspaceFileRead` vor Office ab. Native Antworten enthalten `nativeSource` mit Document-ID, Generation, Sequenz und beobachteter Quelle sowie `contentUnavailable`. Nur ausdrücklich pristine/unregistrierte DOCX erreicht den Office-Snapshot. Native Fehler dürfen nicht in diesen Fallback wechseln. |
| Native Metadaten | [`app/lib/collaboration/workspace-native-file-read.ts`](../app/lib/collaboration/workspace-native-file-read.ts) unterscheidet Metadaten von Text-Export. Eine Metadatenantwort kann bewusst leeren `content` enthalten. Sie ist kein leeres Dokument und kein Initialisierungsauftrag. |
| Client/Store | [`app/lib/files/client.ts`](../app/lib/files/client.ts) gibt die Read-Antwort zurück. [`app/lib/files/types.ts`](../app/lib/files/types.ts) deklariert `nativeSource` und `contentUnavailable` in `CurrentFile` noch nicht. [`app/store/file-store.ts`](../app/store/file-store.ts) baut beim Laden ein neues Objekt ohne diese Felder; Refresh, Cache und Pfadwechsel müssen dieselbe Identität erhalten. |
| Policy | [`app/lib/files/collaboration-policy.ts`](../app/lib/files/collaboration-policy.ts), `buildPostgresState`, erhält vorhandene Yjs-Registryidentität unabhängig vom Suffix. `strategy` und `crdtCapable` stammen weiterhin aus der Suffixstrategie. Ein Registryeintrag allein beweist keinen gültigen initialisierten Native-State. |
| Webeditor | [`app/components/editor/FileEditor.tsx`](../app/components/editor/FileEditor.tsx) aktiviert native Hooks über `crdtCapable` und rendert DOCX/Office vor Markdown/Code. Auch Cmd-S behandelt DOCX vor CRDT; Watcher und Übergangs-/Speicherpfade enthalten weitere Office-Suffixentscheidungen. |
| Vorhandene Bindungen | [`app/lib/collaboration/client.ts`](../app/lib/collaboration/client.ts), `useTextCollaborationSession`, nimmt bereits beliebige Pfadstrings entgegen und prüft erwartete Document-ID. [`CodeEditor.tsx`](../app/components/editor/CodeEditor.tsx) kann explizite Collaboration-Session und Document übernehmen. [`MarkdownEditor.tsx`](../app/components/editor/MarkdownEditor.tsx) setzt bei schreibfähigem XML derzeit `needsRichUpgrade` und damit Rich-Vorbereitung. |
| Session/Reader | [`session-service.ts`](../app/lib/collaboration/session-service.ts), [`native-session-state-reader.ts`](../app/lib/collaboration/native-session-state-reader.ts) und [`authenticated-text-session-service.ts`](../app/lib/collaboration/authenticated-text-session-service.ts) unterstützen derzeit MD/Markdown/TXT. Der neue Service besitzt bereits genuine Originalauth, Native-first, separate Quarantänediagnose, vollständige Originbindung, COMMIT-/Disposalprüfung und private Publication. |
| Transport/Migration | [`authenticated-native-session-transport.ts`](../app/lib/collaboration/authenticated-native-session-transport.ts) und [`app/lib/mobile/collaboration-ticket.ts`](../app/lib/mobile/collaboration-ticket.ts) besitzen eigene Suffixprüfungen. [`rich-migration-domain.ts`](../app/lib/collaboration/rich-migration-domain.ts) begrenzt Migration ebenfalls auf MD/Markdown/TXT. Diese Grenzen dürfen nicht nur im Parser gelockert werden. |
| Publikation | [`checkpoint.ts`](../app/lib/collaboration/checkpoint.ts) schreibt serialisierten Text nach `state.path`, ohne Office-Suffixzweig. [`app/api/files/download/route.ts`](../app/api/files/download/route.ts) exportiert nativen Text mit `application/octet-stream`, behält aber den ursprünglichen Dateinamen. [`workspace-download-archive.ts`](../app/lib/files/workspace-download-archive.ts) verwendet ebenfalls die bisherigen Archivnamen. Textbytes können damit einen `.docx`-Namen tragen. |

## Vorgeschlagener bestehende-native-only Vertrag

### DTO, Policy und UI

`CurrentFile` erhält ausdrücklich deklarierte Native-Identität und `contentUnavailable`. Load, Refresh, wiedergeöffnete Dokumente und verwaltete Pfadänderungen übernehmen diese Felder konsistent. Widersprüchliche Document-ID/Generation oder ein ersetztes Dokument dürfen den laufenden Editor nicht auf eine neue Identität oder Office umstellen; die bestehenden Authscope-, Dirty-State- und Unavailable-Grenzen bleiben bestehen.

Die verifizierte native Read-Antwort darf das effektive UI-Verhalten als Yjs kennzeichnen. Bevorzugt wird ein enger Anschluss dieser Antwort, statt die zentrale Policy aufgrund von `document.provider === 'yjs'` global umzubauen. Die Suffixstrategie für Erstinitialisierung bleibt erhalten.

FileEditor entscheidet zuerst über vorhandene native Identität und löst die tatsächliche Session auf. Solange Session/Document nicht bereit sind, zeigt er den nativen Lade-/Fehlerzustand. Leerer Bootstrap-Text darf weder in Office noch in einen neuen lokalen Y.Doc übernommen werden. Die aktuelle Session bestimmt Darstellung und Read/Write; DTOs dienen nur Anzeige und Identitätsvergleich.

Plain verwendet die bestehende Yjs-Textbindung, Rich die bestehende strukturierte Bindung. Cmd-S, Close/Transition, Watcher und Refresh müssen dieselbe native Auswahl verwenden. Der suffixneutrale Session-Hook kann hierfür unverändert bleiben. Bei Fehlern gibt es keinen Office-/Datei-/Markdown-Rekonstruktionsfallback.

### Authentisierte Session, Reader und WS

Ein enger authentisierter Parser-/Servicepfad nimmt canonical Non-Markdown-Pfade ausschließlich für vorhandenen Native-State an. Der tatsächliche Reader prüft auf eigener aktueller SQL-Phase Registry, aktive Lineage, Native-Zeile, Schema, Binärgrenzen und genaue Workspace-/Pfad-/Generationidentität. Client-Hinweise, behauptete Schreibflags und exportierter Text ersetzen diese Prüfung nicht.

Für fehlenden, pristine, historisch initialisierten fehlenden oder widersprüchlichen Non-Markdown-State ist der Request beendet: kein `ensureDocument`, kein Originalbootstrap, keine Source-/Office-Lesung und kein Seed. Der bisherige MD/Markdown/TXT-Bootstrap bleibt eng begrenzt. Legacy-Gast- und echte Excalidraw-Verträge bleiben getrennt; explizites Yjs auf einem besonderen Suffix verlangt weiterhin tatsächlich vorhandene Yjs-Identität.

Originalheaders werden vor dem ersten Await kopiert. Genuine FIXED CanRead/CanWrite, SAME-B-Finalrechte, vollständiger ursprünglicher Workspace/Realm, bestätigter COMMIT, Capability-Lifetime und Ticket-/Credentialdisposal bleiben unverändert. Quarantäne bleibt eine getrennte genuine CanRead-Diagnose ohne Seed, Migration oder Writegrant.

Nach Abschluss des laufenden WS-Pakets werden Reader, Transport, Join-/Ownerphase und gegebenenfalls Mobile-Ticketprüfung gemeinsam auf diesen vorhandenen Native-Vertrag abgestimmt. Kein Shared-Reader unter exklusivem Bootstrap/Handoff, keine gefälschte Ownerfence und keine retained Principal-/Reader-Fassade. Ein isolierter Parser- oder Rendererpatch ist nicht aktivierungsfähig.

### XML und Migration

Vorhandenes XML muss seine bestehende Rich-Bindung erreichen können, ohne automatisch einen für Non-Markdown unzulässigen Upgrade anzufordern. Dieses UI-Gating darf keine neue Schreibberechtigung oder Migration minten. Plain und Blocks benötigen ebenfalls keinen Darstellungswechsel aus dem Suffix.

Neue Non-Markdown-Migrationsrequests bleiben im ersten Anschluss ausdrücklich abgewiesen. Eine spätere Erweiterung von Coordinator, Checkpoint und Terminal-/Recoveryverträgen ist eine getrennte Aufgabe; die vorhandenen genuine Migrationguards werden nicht pauschal geöffnet.

## Notwendige Entscheidungen vor Editable-Aktivierung

1. **Physischer Checkpoint:** Nicht-Text-Suffixe dürfen keine Textbytes als vermeintliches Office-/Binärprodukt publizieren. Festzulegen ist, wo und wie die native Dauerhaftigkeit und eine optionale Textprojektion bestätigt werden. SQL-Ack, Datei-Checkpoint und finalized Projectionreceipt bleiben getrennte Tatsachen. Ein übersprungener Dateischreibvorgang darf weder `projectionFinalized` noch eine erfolgreiche Close-/Checkpointbarriere vortäuschen.
2. **Expliziter Export:** Markdown-/Text-Export erhält einen passenden Namen, etwa `.md`/`.txt`, und passenden Content-Type. Ein DOCX-/anderer Binärexport benötigt einen tatsächlichen Formatencoder und einen eigenen Vertrag. Einzel-Download, Archivnamen, Namenskollisionen und Shares sind dabei gemeinsam zu behandeln; Umbenennen von Textbytes erzeugt keine Office-Datei.
3. **XML-Gating:** Die genaue UI-Änderung muss vorhandenes XML bearbeiten lassen und zugleich den automatischen Non-Markdown-Upgrade verhindern. Erst diese Prüfung schließt den Rich-Anschluss.
4. **Mobile:** Der erste Umfang ist Web. [`app/lib/mobile/notebook.ts`](../app/lib/mobile/notebook.ts) erlaubt Notebook-Pfade derzeit nur für MD/Markdown/TXT; der Mobile-Session-/Ticketpfad und der externe Mobile-Client sind ein eigener Anschluss. Keine Mobile- oder Geräteabnahme aus Webprüfungen ableiten.

## Schließbare Umsetzungsschritte

| Schritt | Abschlussbedingung |
| --- | --- |
| 1. Publikationsvertrag entscheiden | Checkpointziel, Native-Ack/Close-Verhalten, Exportnamen und MIME sind konkret beschlossen; kein Office-/Binärlabel für Textbytes und kein falscher Receipt. |
| 2. Authentisierten vorhandenen Native-Pfad erweitern | Non-Markdown öffnet nur tatsächlichen Native-State; genuine Header-/Scope-/Final-/COMMIT-/Disposal-Grenzen bestehen; negative Requests erzeugen keinerlei Seed/Registry-/Lineage-/Officewirkung. |
| 3. Reader/WS-Vertrag schließen | Nach dem fertigen WS-Paket akzeptieren reale Join-/Ownerphasen dieselben validierten Pfade. Revoke, Busy/Drain, Quarantäne, alte Generation und Ticketownership bleiben korrekt getrennt. |
| 4. DTO/Store/Editor anschließen | Identität bleibt über Load/Refresh/Rename/Reopen erhalten; native Plain/XML/Blocks haben den richtigen Editor und Speicher-/Übergangspfad; Office wird für Native nie initialisiert. |
| 5. Export/Checkpoint verbinden | Nur tatsächlich bestätigte Native-/Projektionsstände werden gemeldet; richtige Bytes, Namen, MIME, Archivkollisionen und bestehende Office-Dateien sind geprüft. |
| 6. Reale Abnahme und Commit | Die untenstehenden Fälle bestehen über echte API/PG/WS und Browserinteraktion; erforderlicher Build erfolgt vor einer ausdrücklich angeforderten Containerprüfung. Pro abgeschlossener Aufgabe sauberer Commit und `detect_changes`. |

## Tatsächliche positive und negative Abnahmefälle

Die Prüfungen verwenden eigene zufällige Schemas/Document-IDs, echte Cookie-/Bearer-Anfragen, echte exportierte Handler und den genuine Grantservice. Mocks, Ersatzrows oder DOM-Snapshots ersetzen die Authority- und Benutzerprüfung nicht.

| Ebene | Positive Fälle | Negative Fälle und zwingende Invarianten |
| --- | --- | --- |
| API/PG | Vorhandenes Plain/XML/Blocks unter `.docx` und einem weiteren Nicht-Text-Suffix; seq0/leer; fehlende/veraltete physische Projektion; gültiges nicht exportierbares Rich-State; aktuelle CanRead-/CanWrite-Akteure. | Pristine/unregistrierte echte DOCX bleibt Office; fehlender historisch initialisierter State, falsche Registry/Lineage/Generation, corrupt binary/vector/raw schema und gefälschte Native-/Writeflags liefern keinen Native-Seed oder Office-Fallback. Native-before-FS ist durch tatsächliche Nebenwirkungsbeobachtung zu prüfen. |
| Lifetime/Scope | Erfolgreiche Publication erfolgt nach geschlossenen SQL-/Principal-/Readerphasen; tatsächliche Ticketadoption und Wiederöffnung erhalten Identität. | Root/customer/project/Realm-/searchPath-Wechsel, Auth-/Write-Revoke, verlorene COMMIT-Antwort, Close-/Publisherfehler: kein unbestätigtes Ticket, kein Replay, gemintete Credentials disposed. Quarantänediagnose kann weder migrieren noch schreiben. |
| WS | Echter Join, Edit, SQL-Persistenz, Reconnect und verwalteter Rename erhalten dieselbe Document-ID und aktuelle Generation. | Falsche Permission/Identität/Ownerfence, alte Generation, Revocation und Quarantäne verweigern Schreiben; Reserve/Drain-Busy wird nicht als bewiesene Authrevocation behandelt. Gast-/Excalidraw-Pfade bleiben erhalten. |
| UI | Desktop und schmale Ansicht: Plain/XML/Blocks direkt öffnen, Text einfügen, editieren, Undo/Redo, Cmd-S, schließen/wiederöffnen, Refresh/Watcher und Pfadwechsel; Veränderung nach Neustart aus tatsächlicher nativer Persistenz bestätigen. | Kein DocxWorkspaceEditor/Officeimport für Native, kein Empty-State aus Bootstrap-Text, kein unerlaubter XML-Upgrade, keine lokale Rekonstruktion bei Sessionfehlern, kein Dirty-Verlust oder Identitätswechsel bei Replacement; echte Office-Datei bleibt unverändert benutzbar. |
| Export/Checkpoint | Bestätigter, verlustfreier Markdown-/Text-Export mit passenden Bytes, Dateinamen, MIME und korrekter Projectionreceipt; Einzel- und ZIP-Export einschließlich Namenskollisionen. | Text erscheint nicht als `.docx`-/anderes Binärprodukt; nicht exportierbares Native-State bleibt nativ zugänglich und Export scheitert ausdrücklich; keine falsche File-Ack/Close-Erfolgsmeldung und kein unbeabsichtigtes Office-/Binärschreiben. |

## Änderungsradius

Der lesende GitNexus-Audit ergab für `buildPostgresState` CRITICAL (5 direkte/108 gesamte betroffene Symbole), für `useTextCollaborationSession` CRITICAL (3/13) und für `FileEditor` HIGH (2/5). Deshalb zunächst den engen Native-Read-/DTO-Dispatch und die vorhandenen Hook-/Editorbindungen verwenden. Vor tatsächlichen Symboländerungen sind frische Impacts auf dem dann integrierten WS-/Source-Stand nötig. Graphprozesse sind keine vollständige dynamische Abnahme.
