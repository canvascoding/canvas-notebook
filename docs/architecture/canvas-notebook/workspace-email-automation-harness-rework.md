# Kurskorrektur: E-Mail-Automationen im normalen Agent-Harness

## Status und Vorrang

Dieses Dokument ersetzt alle widersprechenden Aussagen der bisherigen V1-Planung zu einer separaten E-Mail-Triage-Runtime und zu einem grundsaetzlichen Auto-Send-Verbot. Mailbox-Zuordnung, Workspace-Grenzen, Inbox-/Outbox-Datenmodell und Audit bleiben bestehen.

## Produktmodell

Eine E-Mail-Triage ist eine vorkonfigurierte **eventbasierte Workspace-Automation**. Sie startet keinen Sonder-Agenten, sondern den in der Automation ausgewaehlten Canvas Agent, den eingebauten E-Mail-Agenten oder einen kompatiblen eigenen Agenten.

Der Nutzer richtet nur ein:

1. Mailbox und Workspace,
2. Agent,
3. Verhalten bei einer neuen E-Mail,
4. Versandmodus.

Die Vorlage setzt den Ereignis-Trigger, sichere Standard-Tools, eine gute Grundanweisung und sinnvolle Zustellung voraus.

## Einheitlicher Lauf

```text
Mailbox-Sync / Provider-Ereignis
  -> idempotentes Workspace-E-Mail-Ereignis
  -> normaler Automation-Run
  -> normale Pi-Session und Agent-Harness
  -> Tool-Calls im Workspace-Scope
  -> Inbox-Fall, Aufgabe, Entwurf oder Versand
```

Der Mail-Sync bleibt Infrastruktur. Er liest oder sendet nicht im Namen eines Agenten. Ab dem Ereignis nutzt die Verarbeitung ausschliesslich den bestehenden Automation-Runner mit einer normalen Pi-Session, Laufhistorie, Modellwahl, Persona, Tool-Loop und Audit-Protokoll.

Pro Inbox-Fall bzw. E-Mail-Thread wird eine reguläre Agent-Session angelegt und bei Folgemails desselben Threads fortgesetzt. Dadurch bleibt der Kontext eines Kundenfalls erhalten, ohne unterschiedliche Kundenfaelle in einer Session zu vermischen.

## Agenten

### Canvas Agent und eigene Agenten

Der Canvas Agent kann direkt in der E-Mail-Triage-Vorlage verwendet werden. Eigene Agenten koennen ebenfalls verwendet werden, wenn ihre effektiven Faehigkeiten die fuer die Vorlage erforderlichen E-Mail-Tools enthalten.

### Eingebauter E-Mail-Agent

Zusätzlich gibt es einen nicht loeschbaren System-Agenten `email-agent`:

- voreingestellte Support-/Triage-Grundanweisung,
- vorkonfigurierte Auswahl sicherer E-Mail-, Inbox-, Outbox- und Workspace-Tools,
- im Agentenbereich bearbeitbare Runtime, Fähigkeiten und Anweisungen,
- wiederherstellbare Standardwerte statt Loeschung.

Er wird wie der Canvas Agent in der normalen Agent-Registry und Runtime gefuehrt, nicht als separater Dienst.

## Tool- und Kontextmodell

Der Automation-Runner erzeugt einen expliziten Ausfuehrungskontext mit `workspaceId`, `mailboxId`, `inboxEventId`, `inboxCaseId` (sobald vorhanden) und Versandmodus. Dieser Kontext wird bei jedem Tool-Call serverseitig geprueft.

Bestehende E-Mail-Tools bleiben erhalten und koennen weiterhin fuer manuelle/interaktive Agenten genutzt werden. Fuer E-Mail-Automationen werden sie durch fachliche Workspace-Tools ergaenzt:

- `email_inbox_get_case`, `email_inbox_update_case`, `email_inbox_assign_case`,
- `email_thread_read`,
- `email_outbox_create_draft`, `email_outbox_update_draft`,
- `todo_create_from_inbox_case`,
- bestehende Workspace-Datei- und Wissenssuche.

Der Agent erhaelt als Startkontext die eingegangene E-Mail, den zugehoerigen Thread, vorhandenen Inbox-Fall, lokale Automationsanweisung und die fuer diesen Fall relevanten Workspace-Regeln. Weiteres Wissen holt er ueber die normalen, begrenzten Tool-Calls.

## Versandmodus

Der Versandmodus gehoert zur E-Mail-Triage-Automation, ist standardmaessig `human_review` und wird bei jedem Tool-Call erzwungen.

| Modus | Erlaubtes Ergebnis |
| --- | --- |
| `draft_only` | Provider-Entwurf oder Workspace-Entwurf, kein Versand |
| `human_review` | Workspace-Outbox; nur ein berechtigter Mensch sendet im UI |
| `direct_send` | Der Agent darf das bestehende Send-Tool benutzen |

`direct_send` ist eine bewusste Workspace-Admin-Einstellung, standardmaessig deaktiviert und vollstaendig auditierbar. In diesem Modus wird `email_send_draft` nur fuer genau diese Automation und ihre gebundene Mailbox freigegeben. Es gibt keine globale, allein durch den Agenten bestimmte Send-Berechtigung.

## Rueckbau des bisherigen Sonderpfads

Die folgenden bereits implementierten Bestandteile bleiben erhalten:

- `workspace_email_mailboxes`, `email_inbox_events`, `email_inbox_cases` und die Outbox-Felder von `email_drafts`,
- Polling, Provider-Idempotenz und die Workspace-Mailbox-Grenze,
- Outbox-UI, menschlicher Versandendpunkt, Versions- und Audit-Pruefung,
- allgemeine Event-Trigger in `automation_jobs`.

Diese Bestandteile werden ersetzt oder umgebaut:

- `app/lib/email/workspace-triage.ts` darf keinen direkten KI-Aufruf, keine feste Heuristik und keine eigene Entwurfslogik mehr enthalten;
- der Poll-Endpunkt uebergibt neue Ereignisse an normale Automation-Runs statt sie selbst zu triagieren;
- die direkte E-Mail-KI-Runtime mit `DEFAULT_AGENT_ID` bleibt fuer den manuellen Composer bestehen, wird aber nicht mehr fuer automatisierte Triage verwendet;
- der bisherige pauschale Tool-Filter im Automation-Runner wird durch eine explizite, serverseitige Automation-Tool-Policy ersetzt. Der progressive `email`-Gateway darf keine Send-Operation anbieten, wenn der Versandmodus dies nicht erlaubt.

## Sicherheitsgrenzen

- Mailbox, Thread, Fall, Entwurf und Workspace werden auf jedem Tool-Call zueinander validiert.
- E-Mail-Inhalte bleiben untrusted input und duerfen keine Tools, Richtlinien oder den Versandmodus aendern.
- Der Agent bekommt keine Secrets und keine frei waehlbare fremde Mailbox.
- Ein Berechtigungs- oder Binding-Wechsel beendet den Run vor einem kritischen Schreib- oder Sendeschritt.
- Jede automatisierte Aenderung und jeder direkte Versand wird mit Session, Run, Agent, Workspace, Mailbox und Version auditiert.
