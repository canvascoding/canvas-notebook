# Workspace-E-Mail-Automationen V1: Datenmodell und Migration

## Zweck und Ausgangslage

Dieses Dokument konkretisiert `WEA-V1-02` aus der V1-Checkliste. Es ist die verbindliche Grundlage fuer die Schema-, API- und Migrationsarbeit.

Heute sind `email_accounts` usergebunden; `email_drafts` kennt keinen Workspace. `automation_jobs` besitzt bereits einen optionalen Workspace-Kontext, setzt ihn aber nicht fuer jeden Job durch und verwendet die Sondertypen `heartbeat` und `webhook`.

V1 veraendert diese Ausgangslage schrittweise und kompatibel:

- Bestehende persoenliche E-Mail-Konten bleiben usergebunden und funktionieren weiter.
- Eine explizite Join-Tabelle ordnet ein zentral konfiguriertes Workspace-Postfach einem Workspace zu.
- Inbox-Fälle und Outbox-Entwürfe verwenden denselben Lifecycle für persönliche und Workspace-Mailboxen.
- Jede neue oder migrierte Automation hat einen expliziten Workspace.
- `heartbeat` wird nicht als neuer Typ fortgefuehrt; die alte Konfiguration wird zu einer normalen geplanten Automation migriert.

## Leitregeln fuer das Schema

1. Provider-Ereignisse und Automationen benötigen einen Workspace; persönliche Inbox-Fälle und Outbox-Entwürfe gehören dagegen direkt dem User und dürfen unzugeordnet bleiben.
2. Eine Business-Mailbox hat in V1 genau eine aktive Workspace-Zuordnung.
3. Eine unzugeordnete persoenliche Mailbox bleibt fuer manuelles Schreiben verfuegbar, ist aber keine Automationsquelle.
4. Provider-Ereignisse und Sendevorgaenge sind idempotent.
5. Ein Agent kann nur Entwuerfe erzeugen; ein `sent`-Status entsteht ausschliesslich durch eine serverseitig validierte User-Aktion.
6. Sensitive Inhalte werden nicht in Logs oder Run-Metadaten dupliziert.

## Bestehende Tabellen und beabsichtigte Erweiterungen

### `email_accounts`

Die Tabelle bleibt die Quelle fuer Providerverbindung und Secret-Referenz. `user_id` bleibt zunaechst erhalten, damit bestehende Konto- und OAuth-Flows kompatibel bleiben.

Neue Felder:

| Feld | Bedeutung |
| --- | --- |
| `account_scope` | `personal`, `workspace` oder ein bestehender Kompatibilitätswert. Persönliche Konten erscheinen ausschließlich unter den persönlichen Integrationen; zentrale Business-Konten ausschließlich unter System-E-Mail. |
| `organization_id` | Bestehendes Feld für Organisations-Kontext; für zentral gespeicherte Workspace-Zugangsdaten nicht die Autorisierungsquelle. |
| `connected_by_user_id` | Der User, der die Verbindung hergestellt oder zuletzt erneuert hat; wird aus dem bestehenden `user_id` migriert. |
| `automation_enabled_at` | Zeitpunkt, an dem das Konto erstmals als Automationsquelle freigegeben wurde; ansonsten leer. |

`user_id` bleibt aus Kompatibilitätsgründen ein technischer Protokoll- und Provider-Actor. Bei `account_scope = workspace` liegt die Secret-Referenz jedoch im zentralen Organisations-Scope. Das Postfach wird nicht in den persönlichen Integrationen dieses Users gezeigt. Ausschließlich ein Organisations-Admin darf es zentral verbinden, testen, erneuern oder trennen; die fachliche Workspace-Zuordnung ist davon getrennt.

### Konfigurationsoberfläche

- **Einstellungen → Integrationen → Meine E-Mail-Konten:** ausschließlich persönliche Konten des aktuellen Users.
- **Einstellungen → System-E-Mail → Business-Mailboxen:** ausschließlich Organisations-Admins konfigurieren, testen, erneuern oder trennen hier zentrale SMTP/IMAP-Postfächer. Sie wählen dort keinen Ziel-Workspace.
- **Workspace → E-Mail / Automationen:** Workspace-Admins ordnen eine zentral verbundene, noch nicht aktive Business-Mailbox ihrem Workspace zu oder heben diese Zuordnung wieder auf. Eine Zuordnung aktiviert in V1 nie mehr als einen Workspace je Mailbox.
- System-SMTP für App-Benachrichtigungen und Workspace-Postfächer bleiben zwei getrennte Konfigurationen im selben Admin-Bereich.

### Neue Tabelle `workspace_email_mailboxes`

Sie ist die fachliche Berechtigungsgrenze zwischen Mailbox und Workspace.

| Feld | Bedeutung |
| --- | --- |
| `id` | Stabile ID der Zuordnung. |
| `workspace_id` | Nicht null, Fremdschluessel auf `canvas_workspaces`. |
| `email_account_id` | Nicht null, Fremdschluessel auf `email_accounts`. |
| `status` | `active`, `paused`, `disconnected` oder `archived`. |
| `role` | V1: `inbound_outbound`; fuer spaeter `inbound` und `outbound`. |
| `created_by_user_id` | Workspace-Admin, der die Zuordnung angelegt hat. |
| `last_edited_by_user_id` | Letzte verantwortliche User-Aktion. |
| `created_at`, `updated_at`, `paused_at` | Lifecycle und Auditbasis. |

Indizes und Constraints:

- Index auf `(workspace_id, status)` fuer die Workspace-Ansicht.
- Index auf `(email_account_id, status)` fuer Ereignisauflösung.
- In V1 darf es hoechstens eine aktive Zuordnung je `email_account_id` geben. Eine verbundene, aber unzugeordnete Business-Mailbox bleibt inaktiv und ist keine Automationsquelle. SQLite und PostgreSQL erhalten dazu einen partiellen Unique-Index auf aktive Zeilen.
- Service und API pruefen zusaetzlich, dass eine `organization`-Mailbox nur in einen Workspace derselben Organisation gebunden werden kann.

### Tabelle `email_inbox_cases` und persönliche Fälle

Ein Inbox-Fall ist die schlanke V1-Repräsentation eines Support-Vorgangs, kein vollstaendiges CRM-Ticket.

| Feld | Bedeutung |
| --- | --- |
| `id` | Stabile Fall-ID. |
| `workspace_id` | Nicht null; zentrale Zugriffs- und Auditgrenze. |
| `mailbox_id` | Nicht null; Verweis auf `workspace_email_mailboxes`. |
| `provider_thread_id` | Provider-Thread oder stabiler Fallback-Thread-Schluessel. |
| `latest_provider_message_id` | Zuletzt verarbeitete Nachricht. |
| `requester_address`, `requester_name` | Normalisierte Absenderdaten. |
| `subject` | Aktueller, gekuerzter Betreff. |
| `status` | `new`, `in_progress`, `awaiting_review`, `answered`, `closed`, `needs_routing`. |
| `priority` | `low`, `normal`, `high`, `urgent`; anfänglich `normal`. |
| `assignee_user_id` | Optionaler menschlicher Bearbeiter. |
| `created_at`, `updated_at`, `closed_at` | Lifecycle. |

Der eindeutige Schlüssel `(mailbox_id, provider_thread_id)` verhindert neue Faelle fuer bereits bekannte Threads. Ist kein Provider-Thread vorhanden, wird ein dokumentierter Fallback-Schluessel aus normalisiertem Absender, Betreff und Conversation-Headers verwendet.

Für persönliche, nicht zugeordnete Mailboxen gibt es parallel `personal_email_inbox_cases`. Sie verwendet `user_id`, `email_account_id` und denselben Thread-, Status-, Prioritäts- und Bearbeiter-Lifecycle. Dadurch wird keine versteckte Default-Workspace-Zuordnung erzeugt.

### Neue Tabelle `email_inbox_events`

Diese Tabelle entkoppelt Provider-Eingang von Agentenarbeit und liefert Idempotenz.

| Feld | Bedeutung |
| --- | --- |
| `id` | Interne Ereignis-ID. |
| `mailbox_id` | Nicht null; bestimmt den Workspace. |
| `workspace_id` | Nicht null; als denormalisierter Scope fuer sichere Abfragen. |
| `provider_message_id` | Provider-Message-ID, falls vorhanden. |
| `provider_thread_id` | Thread-Bezug. |
| `idempotency_key` | Nicht null, eindeutiger Schluessel pro Mailbox. |
| `event_type` | V1: `message_received`, `sync_gap`, `provider_error`. |
| `received_at`, `processed_at` | Empfang und erfolgreiche Verarbeitung. |
| `status` | `pending`, `processing`, `processed`, `ignored`, `failed`, `needs_routing`. |
| `attempt_count`, `next_attempt_at`, `error_code` | Sicheres Retry-Verhalten ohne Mailinhalt im Fehlertext. |
| `case_id` | Nach Auflösung verknuepfter Inbox-Fall. |
| `metadata_json` | Strukturelle, redigierte Provider-Metadaten; kein vollstaendiger Klartext-Body. |

Unique-Index: `(mailbox_id, idempotency_key)`. Providerdaten werden bei Bedarf beim Provider gelesen oder in einer gesonderten, retention-gesteuerten Inhaltsablage gespeichert. Run-Logs enthalten nur IDs und redigierte Metadaten.

### Erweiterung von `email_drafts` zur Workspace-Outbox

Die vorhandene Tabelle `email_drafts` wird erweitert, nicht parallel ersetzt. Sie bleibt die Quelle fuer Composer und Provider-Draft-Synchronisation.

| Feld | Bedeutung |
| --- | --- |
| `workspace_id` | Für Workspace-Outbox-Entwürfe verpflichtend; bei persönlichen Entwürfen leer. |
| `mailbox_id` | Verweis auf `workspace_email_mailboxes` für Workspace-Entwürfe. |
| `inbox_case_id`, `personal_inbox_case_id` | Optionaler Fallbezug, passend zum Mailbox-Scope. |
| `origin` | `manual` oder `automation`. |
| `origin_automation_job_id`, `origin_run_id`, `origin_agent_id` | Herkunft eines Agent-Entwurfs; optional. |
| `outbox_status` | `prepared`, `awaiting_review`, `editing`, `sent`, `discarded`, `send_failed`. |
| `version` | Positive Ganzzahl; wird bei jeder inhaltlichen Aenderung erhoeht. |
| `assigned_user_id` | Bearbeiter der menschlichen Pruefung. |
| `editing_by_user_id`, `editing_started_at` | Kurzlebige Bearbeitungssperre. |
| `sent_by_user_id`, `sent_at` | Pflicht fuer `sent`; nur menschlicher Versand. |
| `provider_message_id`, `provider_thread_id` | Ergebnis des manuellen Versands und Thread-Verknuepfung. |

Constraints und Service-Regeln:

- `origin = automation` darf nie direkt `outbox_status = sent` setzen.
- Ein automatischer Entwurf wird bei aktiver menschlicher Bearbeitung nicht überschrieben. Stattdessen entsteht eine neue Version oder ein Review-Hinweis.
- Der Send-Service verlangt entweder Workspace- und Mailbox-Zugriff oder den persönlichen Owner sowie die erwartete `version`.
- `sent_by_user_id` ist bei jedem versendeten Workspace-Entwurf nicht null.

### Erweiterung von `automation_jobs`

Der allgemeine Job bleibt bestehen. Neue Felder vermeiden Heartbeat-Sonderlogik:

| Feld | Bedeutung |
| --- | --- |
| `trigger_type` | `schedule`, `event`, `webhook`, `manual`; V1-Jobs nutzen `schedule` oder `event`. |
| `result_policy` | `deliver_all`, `deliver_relevant_only`, `record_only`. |
| `event_config_json` | Ereignisquelle, etwa `email_inbox_event`; fuer geplante Jobs leer. |
| `instruction_version` | Optionaler Snapshot-/Migrationszähler fuer den Auftrag. |

`prompt` wird zur normalen Automationsanweisung weiterverwendet. Der bisherige `job_type = heartbeat` wird nach erfolgreicher Migration in `job_type = default`, `trigger_type = schedule` und `result_policy = deliver_relevant_only` ueberfuehrt. Neue Produktlogik liest `job_type` nicht mehr als fachlichen Ausfuehrungsmodus; bestehende Webhook-Kompatibilität wird separat erhalten, bis sie auf `trigger_type` migriert ist.

Fuer neue und migrierte V1-Automationen ist `workspace_id` im Service verpflichtend. Das Datenbankfeld bleibt waehrend der Upgrade-Phase nullable, damit nicht betroffene Legacy-Automationen kontrolliert migriert werden koennen.

## Migrationsreihenfolge

Die Migration wird fuer SQLite und PostgreSQL in derselben fachlichen Reihenfolge umgesetzt. Jeder Schritt ist idempotent und erzeugt keine Netzwerk- oder Agentenarbeit.

1. **Schema erweitern:** Neue Tabellen und additive Spalten/Indizes anlegen. Noch keine bestehenden Läufe oder Mailboxen aktiv verändern.
2. **Konten klassifizieren:** Alle bestehenden `email_accounts` als `personal` markieren. Zentral verwaltete Business-Konten werden anschließend zu `workspace`, erscheinen nicht mehr unter persönlichen Integrationen und bleiben bis zur bewussten Zuordnung eines Workspace-Admins nicht automatisiert.
3. **Heartbeat vorbereiten:** Für jeden bestehenden Heartbeat den persönlichen Standard-Workspace zuverlässig auflösen. Fehlt er, Job auf `paused` lassen und einen migrationssicheren Fehlerstatus erfassen.
4. **Heartbeat migrieren:** Genau eine normale geplante Automation je Altjob upserten; Zeitplan, Zustellung und der Inhalt von `HEARTBEAT.md` werden als `prompt` übernommen. Eine Migrationstabelle oder ein stabiler `legacy_heartbeat_job_id`-Verweis verhindert Duplikate.
5. **Alte Heartbeats stilllegen:** Erst nachdem der Zieljob aktiv und validiert ist, den Altjob pausieren. Die alte Settings-UI bleibt während der Übergangsphase nur lesbar.
6. **Mailbox-Automation aktivieren:** Erst eine aktive `workspace_email_mailboxes`-Zuordnung darf `automation_enabled_at` setzen und Provider-Ereignisse annehmen.
7. **HEARTBEAT.md entfernen:** Erst nach einer Release-Übergangsphase und einem Migrationsreport aus den verwalteten Agent-Dateien entfernen.

## Rückbau und Fehlerbehandlung

- Schlägt eine Datenmigration fehl, bleiben Altjob und Mailbox unverändert aktiv bzw. nutzbar; es wird kein halb migrierter Automationsjob ausgeführt.
- Eine fehlerhafte Workspace-Auflösung pausiert nur den betroffenen migrierten Job und erzeugt eine sichtbare Admin-Aktion.
- Kein Migrationsschritt löscht E-Mail-Entwürfe oder Secrets.
- Rollback erfolgt durch Pausieren der neuen Jobs und Wiederfreigabe der alten Settings, nicht durch destruktives Zurückschreiben von Inhalten.

## Zu testende Invarianten

- Eine Mailbox hat in V1 nie zwei aktive Workspace-Zuordnungen.
- Dieselbe Provider-Nachricht führt höchstens zu einem Inbox-Ereignis und einem Fall-Update.
- Workspace-Inbox-Fälle und -Outboxen sind strikt workspace-isoliert; persönliche Fälle und Entwürfe sind strikt user-isoliert.
- Kein `sent`-Outbox-Eintrag kann ohne menschliche User-ID entstehen.
- Ein No-op einer geplanten Automation kann keine externe Benachrichtigung erzeugen.
- Die Heartbeat-Migration ist bei zwei Durchläufen stabil und verliert weder Zeitplan noch Anweisung.
