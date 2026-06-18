# Knowledge Ingestion und Retrieval Policy

Stand: 2026-06-18

## Zweck

Dieses Dokument konkretisiert, wie Canvas Notebook Knowledge Sources automatisch erkennt, parst, scannt, indexiert und spaeter fuer Retrieval nutzt. Es gleicht den separaten `docs/docling-knowledge-ingestion-plan.md` mit dem Team-Workspace-Umbau ab.

Es ergaenzt die Aufgaben `25`, `26`, `29`, `30`, `31` und `36` im Aufgabenindex.

Resource- und Backpressure-Regeln fuer kleine VMs sind verbindlich in `13-resource-aware-ingestion-and-job-backpressure.md` beschrieben.

## Grundentscheidung

Die Knowledge Base soll automatisch aufgebaut werden koennen, aber nicht ungeprueft scope-uebergreifend und nicht unbemerkt ressourcenintensiv. In V1 ist schwere automatische Ingestion default `off`; nach Admin-Aktivierung laeuft sie automatisch, ohne dass User Dateien manuell in eine Knowledge Base hochladen muessen.

Regeln:

- Personal Workspace Inhalte werden automatisch in eine private User Knowledge Base indexiert, wenn `knowledgeAutoIngestionEnabled` fuer diesen Scope aktiv ist.
- Team Workspace Inhalte werden automatisch in eine Team Knowledge Base indexiert, wenn die Organization Policy dies erlaubt und `knowledgeAutoIngestionEnabled` aktiv ist.
- Organization Knowledge ist fuer V1 nicht zwingend getrennt vom Team Workspace, bleibt aber als spaetere Governance-Ebene vorbereitet.
- E-Mail-Inhalte werden in V1 nicht in die Knowledge Base aufgenommen.
- Studio-Medien wie Bilder, Videos und Audio werden in V1 nicht als Vollinhalt indexiert; hoechstens Metadaten oder explizit erzeugte Textartefakte.
- Public Links bedeuten keine automatische Knowledge-Freigabe.
- Remote Docling ist kein V1-Default; V1 nutzt lokale Verarbeitung oder Sidecar/CLI mit harten Limits.
- Docling, OCR, Embedding-Indexing und Remote Parsing haben eigene Admin-Toggles und starten default `off`.
- Alle Ingestion-/Parser-/Embedding-Jobs schreiben strukturierte Operational Logs ohne Dokumentinhalte oder Secrets.

## Knowledge Scopes

V1 unterscheidet diese Knowledge Stores:

| Store | Quelle | Sichtbarkeit | Default |
|---|---|---|---|
| `personal_user` | eigener Personal Workspace | nur Owner-User | automatisch aktiv |
| `team_workspace` | Team Workspace | berechtigte Team-User | admin-/policy-gesteuert aktiv |
| `organization` | kuratierte Organization Sources | Owner/Admin oder berechtigte Rollen | vorbereitet, nicht zwingend V1 |

Physische oder logische Trennung:

- Fuer V1 bevorzugt getrennte Tabellen/Collections oder zumindest harte Partitionierung pro User und Team/Organization.
- Ein gemeinsamer Vektorindex ist nur zulaessig, wenn jeder Eintrag `organizationId`, `workspaceId`, `userId`, `visibility` und `sourceRef` besitzt und Retrieval serverseitig filtert.
- Wenn Zweifel bestehen, wird staerker getrennt: pro User ein privater Index/Store und eigene Team-/Organization-Stores.

## Quellen

Automatisch erlaubt:

- Dokumente im eigenen Personal Workspace.
- Dokumente im Team Workspace, wenn Team Knowledge Policy aktiv ist.
- Doc/PDF/Text/Markdown/Office-Dateien, soweit Parser und Limits sie unterstuetzen.

Nicht automatisch erlaubt:

- E-Mails und Mailbox-Inhalte.
- Private E-Mail-Anhaenge, ausser sie wurden explizit als Datei in einen Workspace kopiert.
- Studio Bilder, Videos, Audio und generierte Medien als Vollinhalt.
- Secrets-, Env-, Token-, Key- und Credential-Dateien.
- Runtime-/Settings-/MCP-/Plugin-/Skill-Konfigurationen.
- Trash, Revisions und Backups.
- Public-Link-Targets nur wegen Public Link.

Studio-Regel:

- Studio Assets bleiben Asset-Daten, keine Knowledge-Dokumente.
- Falls ein Studio-Output eine Textbeschreibung, Transkription, Prompt-Dokumentation oder Caption als Datei erzeugt, kann nur dieses Textartefakt nach Policy indexiert werden.

## Automatische Ingestion

Automatische Ingestion laeuft als Background Job.

Pipeline:

1. Source erkennen oder File-Event empfangen.
2. Source Scope aus Workspace-Metadaten bestimmen.
3. Dateityp und Exclude-Regeln pruefen.
4. Parser auswaehlen: native, Docling lokal/Sidecar oder disabled.
5. Text/Markdown/Struktur extrahieren.
6. Secret-/PII-/Prompt-Injection-Scan ausfuehren.
7. Policy-Entscheidung treffen: allow, redact, quarantine, metadata-only, block.
8. Chunks erzeugen.
9. Embeddings nur fuer erlaubte oder redacted Chunks erzeugen.
10. Index/Store aktualisieren.
11. Audit- und Statusdaten speichern.

Docling wird fuer schwere Knowledge-Ingestion genutzt, nicht automatisch fuer normale Agent-`read`-Tools.

## Secret- und PII-Scan

Der Scan ist Pflicht vor Chunking/Embedding.

Secret Scan sucht nach:

- API Keys,
- OAuth Tokens,
- Private Keys,
- Bearer Tokens,
- Webhook Secrets,
- Datenbank-URLs mit Passwort,
- `.env`-aehnlichen Inhalten,
- Provider-spezifischen Key-Patterns.

PII Scan sucht best-effort nach:

- E-Mail-Adressen,
- Telefonnummern,
- Adressen,
- IBAN/Bankdaten,
- Ausweis-/Steuer-/Kundennummern,
- HR-/Vertrags-/Gesundheitsdaten, soweit erkennbar.

Wichtig:

- Der Scan ist ein Schutzgurt, kein Berechtigungsersatz.
- Auch mit korrekten ACLs bleiben Embeddings abgeleitete sensible Daten.
- Scan-Ergebnisse muessen Source, Chunk und Policy-Entscheidung referenzieren.
- Treffer bedeuten nicht immer Leak; PII kann fachlich legitimer Dokumentinhalt sein.

Policy-Modi:

| Modus | Verhalten |
|---|---|
| `allow` | normal indexieren |
| `redact` | sensible Stellen vor Chunking/Embedding entfernen oder maskieren |
| `quarantine` | Source nicht indexieren, Review erforderlich |
| `metadata-only` | nur Source-Metadaten speichern, kein Inhalt/Embedding |
| `block` | Source komplett aus Knowledge ausschliessen |

Konservativer Default:

- Secrets/Keys: `quarantine` oder `block`.
- Normale PII in Personal Knowledge: `allow` mit Metadaten, weil nur Owner Zugriff hat.
- Normale PII in Team Knowledge: `allow` oder `redact` nach Organization Policy.
- Hochsensible Treffer: `quarantine`.

## Berechtigung und Retrieval

Retrieval darf nie direkt aus dem Vektorindex an den Agenten liefern.

Pflichtschritte:

1. `AgentExecutionContext` oder serverseitigen Search Context aufloesen.
2. Erlaubte Knowledge Stores bestimmen.
3. Query nur mit Scope-Filtern ausfuehren.
4. Treffer erneut gegen Source ACL pruefen.
5. Ergebnis mit Source-Zitat, Workspace und Pfad zurueckgeben.

Regeln:

- Personal Knowledge ist nur fuer den Owner sichtbar.
- Team Knowledge ist nur fuer berechtigte Team-User sichtbar.
- Organization Knowledge ist nur fuer berechtigte Rollen sichtbar.
- Fremde Personal Knowledge ist immer tabu.
- Cross-Workspace Retrieval folgt den Read-Grant-Regeln aus `10-agent-tool-execution-policy.md`.

## Source References

Jeder Chunk muss zur Quelle zurueckfuehren.

Pflichtmetadaten:

- `organizationId`
- `workspaceId`
- `userId`
- `knowledgeStore`
- `visibility`
- `sourceId`
- `sourceType`
- `sourcePath`
- `contentHash`
- `chunkIndex`
- `pageStart`
- `pageEnd`
- `parserProvider`
- `scanStatus`
- `policyDecision`
- `createdAt`
- `updatedAt`

UI-/Agent-Ergebnisse muessen Quelle, Pfad, Seite/Abschnitt und Workspace anzeigen koennen. Der User muss die vollstaendige Information in der jeweiligen Quelldatei wiederfinden koennen.

## Delete, Move, Permission Change

Loeschen oder Verschieben einer Source muss Derivate behandeln:

- Chunks entfernen oder deaktivieren.
- Embeddings entfernen oder als revoked markieren.
- Graph-Entities/Relations aus dieser Source entfernen oder neu berechnen.
- Search Cache invalidieren.
- Audit Event schreiben.

Permission-Aenderung:

- Retrieval-Filter greifen sofort.
- Reindex/Cleanup laeuft async.
- Bis Cleanup fertig ist, duerfen revoked Chunks durch ACL-Filter nicht erreichbar sein.

## Datenmodell-Ergaenzung

Zum Docling-Plan werden zusaetzlich benoetigt:

- `knowledgeStore`: `personal_user` | `team_workspace` | `organization`
- `scanStatus`: `pending` | `clean` | `flagged` | `quarantined` | `blocked`
- `policyDecision`: `allow` | `redact` | `quarantine` | `metadata-only` | `block`
- `sourceAclVersion`
- `indexVersion`
- `revokedAt`
- `lastAccessCheckedAt`

## Compute und Remote Parsing

V1:

- Docling lokal/CLI/Sidecar, nicht remote als Default.
- Schwere Ingestion, Docling, OCR und Embeddings default `off`, bis ein Admin oder Managed Policy sie aktiviert.
- Max concurrent parse jobs: `1`.
- Harte Limits fuer Dateigroesse, Seitenzahl, OCR-Seiten, Timeout und Speicher.
- Resource Budget vor jedem schweren Parse-/Embedding-Job pruefen.
- Bei knappen Ressourcen Jobs auf `deferred_low_resources`, `metadata_only` oder `failed_resource_limit` setzen statt unkontrolliert zu starten.
- OCR und layoutbewusste Extraktion bei `low` Resource Profile standardmaessig deaktivieren oder stark begrenzen.
- Native Fallback bei Fehler.
- Status in Settings.

Remote Docling:

- spaeter moeglich, aber nur mit Admin-Policy, expliziter Datenverarbeitungsentscheidung, Secret-Management und Audit.
- Remote Parsing ist Datenabflussrisiko und deshalb kein Standard.

## Tests

Pflichttests:

- Personal Workspace Datei wird in private User Knowledge indexiert.
- Team Workspace Datei wird nur bei aktivierter Team Knowledge Policy indexiert.
- E-Mail-Inhalt wird nicht automatisch indexiert.
- Studio Medien werden nicht als Vollinhalt indexiert.
- `.env`/Secret-Dateien werden blockiert oder quarantined.
- Secret-Treffer verhindern Embedding vor Review.
- Retrieval aus Personal Knowledge ist fuer andere User blockiert.
- Team Retrieval liefert nur Quellen mit Team-Zugriff.
- Permission-Entzug blockiert Retrieval sofort.
- Source Delete entfernt oder revoked Chunks und Embeddings.
- Treffer enthalten Source, Pfad, Workspace und Seite/Abschnitt.
- Remote Docling ist im V1-Default deaktiviert.
- Low-Resource-Profil erzwingt Backpressure oder Degradation ohne Embedding ungescannter Inhalte.
- Default-off: Frische und migrierte Instanzen starten keine schweren Ingestion-Jobs ohne explizite Aktivierung.
- Logging: Job-Status, Resource-Entscheidung und Parser-Fehler werden strukturiert geloggt, ohne Rohinhalt oder Secrets.
