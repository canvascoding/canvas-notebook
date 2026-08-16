# Kurskorrektur: E-Mail-Automationen im normalen Agent-Harness

## Status und Vorrang

Dieses Dokument ersetzt alle widersprechenden Aussagen der bisherigen V1-Planung zu einer separaten E-Mail-Triage-Runtime. Mailbox-Zuordnung, Workspace-Grenzen, Inbox-/Outbox-Datenmodell, menschliche Freigabe und Audit bleiben bestehen.

## Produktmodell

Eine E-Mail-Triage ist eine vorkonfigurierte **eventbasierte Workspace-Automation**. Sie startet keinen Sonder-Agenten, sondern den in der Automation ausgewaehlten Canvas Agent, den eingebauten E-Mail-Agenten oder einen kompatiblen eigenen Agenten.

Der Nutzer richtet nur ein:

1. Mailbox und Workspace,
2. Agent,
3. Verhalten bei einer neuen E-Mail,
4. menschliche Freigabe in der Outbox.

Die Vorlage setzt den Ereignis-Trigger, sichere Standard-Tools, eine gute Grundanweisung und sinnvolle Zustellung voraus.

## Einheitlicher Lauf

```text
Mailbox-Sync / Provider-Ereignis
  -> idempotentes Workspace-E-Mail-Ereignis
  -> normaler Automation-Run
  -> normale Pi-Session und Agent-Harness
  -> Tool-Calls im Workspace-Scope
  -> Inbox-Fall, Aufgabe oder Outbox-Entwurf
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

Die E-Mail-Tools sind normale, konfigurierbare Agent-Faehigkeiten. In einer normalen Session waehlt der Agent eine persönliche oder aktive Workspace-Mailbox; jede Auswahl wird serverseitig gegen Eigentum beziehungsweise Workspace-Mitgliedschaft geprueft. Ein Automation-Run verwendet dieselben Tools, bindet aber die ausloesende Workspace-Mailbox serverseitig. Er darf dort bei Bedarf weitere relevante Nachrichten suchen und lesen.

Es gibt nur eine sichtbare E-Mail-Tool-Familie:

- `email_list_mailboxes`, `email_search_messages`, `email_read_message`, `email_list_thread_messages`,
- `email_list_cases`, `email_create_or_update_case`,
- `email_create_outbox_draft`, `email_update_outbox_draft`, `email_list_outbox_drafts`.

Alle Tools nehmen eine `mailboxId`. Persönliche Mailboxen sind User-eigen und verwenden eine `account:`-Mailbox-ID; Workspace-Mailboxen werden über ihre Workspace-Zuordnung aufgelöst. In einer E-Mail-Automation bleibt die Mailbox serverseitig fest gebunden.
- bestehende Workspace-Datei- und Wissenssuche.

Der Agent erhaelt als Startkontext die eingegangene E-Mail, den zugehoerigen Thread, vorhandenen Inbox-Fall, lokale Automationsanweisung und die fuer diesen Fall relevanten Workspace-Regeln. Weiteres Wissen holt er ueber die normalen, begrenzten Tool-Calls.

## Freigabe und Versand

Automationen und E-Mail-Tools erstellen und aendern nur Outbox-Entwuerfe. Der Versand bleibt in V1 eine explizite menschliche Aktion im E-Mail-UI. `draft_only` und `human_review` bestimmen nur den sichtbaren Review-Status des Entwurfs; es gibt keinen Agenten-Sendetool und keinen automatischen Versand.

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
- der Automation-Runner ersetzt allgemeine Workspace-E-Mail-Tools durch dieselben Tools mit gebundener Ausloeser-Mailbox. Der allgemeine `email`-Gateway und seine Send-Operationen stehen Automation-Runs nicht zur Verfuegung.

## Sicherheitsgrenzen

- Mailbox, Thread, Fall, Entwurf und Workspace werden auf jedem Tool-Call zueinander validiert. Ein Automation-Run darf innerhalb seiner gebundenen Mailbox nach weiterem Kontext suchen, aber keine andere Mailbox auswaehlen.
- E-Mail-Inhalte bleiben untrusted input und duerfen keine Tools, Richtlinien oder den Versandmodus aendern.
- Der Agent bekommt keine Secrets und keine frei waehlbare fremde Mailbox.
- Ein Berechtigungs- oder Binding-Wechsel beendet den Run vor einem kritischen Schreibschritt.
- Jede automatisierte Aenderung sowie jeder menschliche Versand wird mit Session, Run, Agent, Workspace, Mailbox und Version auditiert.
