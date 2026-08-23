---
title: 'Umsetzungsplan zu Ticket 29: Notification-Zentrum, To-do-Attention und E-Mail-Review'
status: planned
date: 2026-08-23
platforms: [web, server, mobile-api]
tags: [type/implementation-plan, topic/notifications, topic/todos, topic/email, topic/workspaces]
---

# Umsetzungsplan: Notification-Zentrum, To-do-Attention und E-Mail-Review

## Auftrag und Grenze

Dies ist die zentrale, verbindliche Planung fuer Ticket 29. Sie konsolidiert
die Grundlagen aus Tickets 02, 03 und 14, ohne deren Vollansichten zu
duplizieren.

| Flaeche | Verantwortung | Nicht Bestandteil |
| --- | --- | --- |
| To-do-App | vollstaendige, filterbare Arbeitsliste und Lifecycle | globale Ereignisbenachrichtigung |
| E-Mail-App | Mailbox, Fallbearbeitung, Entwurfeditor und Versand | globale Kurzpriorisierung |
| Notification-Zentrum | wenige handlungsrelevante Ereignisse, To-dos und Reviews | Vollisten, Live-Providerabrufe |
| Startseite | maximal verdichtete Auswahl derselben Attention-Daten | eigene Relevanzlogik |

Der Server leitet Scope, Read-State, To-do-Relevanz, E-Mail-Rechte und
Sendefaehigkeit ab. Der Client ist dafuer keine Autoritaet.

## Belegter Ausgangszustand

| Pfad | Befund |
| --- | --- |
| `app/api/notifications/summary/route.ts` | ruft dreimal den breiten Aggregate-Inbox-Feed auf und liefert bis zu 50 To-dos |
| `app/components/notifications/NotificationBell.tsx` | hat Ereignis- und To-do-Sektion, aber keine E-Mail-Review-Sektion; `Alle gelesen` beruehrt heute auch To-dos |
| `app/lib/mobile/inbox.ts` | sammelt Chat, E-Mail-Attention, To-dos, Studio und Automationen; es ist keine gezielte Web-Attention-Projektion |
| `app/lib/todos/store.ts`, `read-state-policy.ts` | liefern autorisierte To-dos und den effektiven Read-State; `done`/`archived` sind immer `read` |
| `app/lib/email/inbox-attention.ts` | liefert deduplizierte persistierte Faelle und Agent-/Automation-Entwuerfe, die in der Web-Summary fehlen |
| `app/lib/email/workspace-inbox-outbox.ts` | besitzt die alleinige Sendelogik: Schreibrecht, erwartete Version, Reservierung, Audit und Fehlerzustand |

## Verbindliche Semantik

### Drei Sektionen statt einer unklaren Gesamtrangliste

1. **Benachrichtigungen:** Chat-Antworten, Studio-Ergebnisse und
   fehlgeschlagene Automationen. Sortierung: ungelesen, hohe Prioritaet,
   Ereigniszeit absteigend.
2. **E-Mail-Review:** Zustandsfolge `send_failed`, `awaiting_review`, dem
   Viewer zugewiesene Faelle ohne Entwurf, `needs_routing`/`new`/
   `in_progress`, dann aktuellste Aenderung.
3. **Relevante To-dos:** eigene To-do-Rangfolge, maximal sechs Eintraege.

Sektionen verhindern einen falschen globalen Vergleich zwischen einem
fehlgeschlagenen E-Mail-Versand und einem faelligen To-do. Jede Sektion hat
einen Link zur Vollansicht.

### Counts und Bulk-Aktionen

| Wert | Semantik | Ausgeschlossen |
| --- | --- | --- |
| `unreadCount` / Glocke | nur ungelesene Ereignisbenachrichtigungen | To-dos, E-Mails, dismissed/gelesene Ereignisse |
| `todoAttentionCount` | geeignete offene To-dos vor UI-Limit | done, archived, fremde oder unzugaengliche To-dos |
| `emailAttentionCount` | deduplizierte aktionserforderliche Faelle/Entwuerfe | Provider-Unreads, sent, discarded, answered, closed |

`Alle Benachrichtigungen gelesen` wirkt ausschliesslich auf Ereignisse.
Einzelne offene To-dos koennen weiterhin bewusst gelesen/ungelesen werden;
dies ist weder Abschluss noch eine Bulk-Aktion. Das Oeffnen einer E-Mail-
Attention aendert deren fachlichen Fall-/Entwurfsstatus nicht.

### To-do-Attention-Policy

Die reine, serverseitige Policy arbeitet mit bereits autorisierten,
hydratisierten To-dos, Viewer-ID und einem Request-Zeitpunkt.

- Eignung: nur `open`; persoenliche To-dos des Viewers; geteilte To-dos, die
  ihm zugewiesen sind; selbst erstellte, noch unzugewiesene To-dos.
- Nicht geeignet: `done`, `archived`, fremd zugewiesene nur lesbare Team-
  To-dos.
- Relevanzgruende: `overdue`, `due_today`, `high_priority`, `unread`,
  `due_soon`; mindestens einer ist erforderlich.
- Reihenfolge: ueberfaellig, heute faellig, hohe Prioritaet, ungelesen,
  innerhalb von sieben Tagen faellig; danach direkte Zuweisung vor selbst
  erstellt, Fälligkeit, Aktualitaet und ID.

Die Zeile zeigt den staerksten Grund, Workspace und Fälligkeitsdatum. "Alle
To-dos anzeigen" geht nach `/todos`; dort allein ist die komplette Liste.

### E-Mail-Review und Human-in-the-loop

Die Projektion verwendet nur `email_inbox_cases`,
`personal_email_inbox_cases` und `email_drafts`; keine Gmail-, Microsoft- oder
IMAP-Liveabfrage. Ein Fall mit zugehoerigem Entwurf ist ein Eintrag.

| Zustand | Darstellung und Aktion |
| --- | --- |
| `send_failed` | hoechste Prioritaet, Entwurf pruefen und erneuten Versand bestaetigen |
| Agent-/Automation-Entwurf `awaiting_review` | Review, dann Versand bestaetigen |
| zugewiesener Fall ohne Entwurf | im E-Mail-Bereich pruefen |
| `needs_routing`, `new`, `in_progress` | im E-Mail-Bereich oeffnen |
| `editing` durch andere Person | als in Bearbeitung, ohne Sende-CTA |

Die Liste zeigt nur Betreff, Status, Prioritaet, Workspace, Zeit und erlaubte
Aktionen. Empfaenger, Body, Header, Tokens und Secrets werden erst beim
frischen, autorisierten Oeffnen geladen. `Pruefen` oeffnet den bestehenden
Editor. `Jetzt senden` oeffnet zuerst eine Bestaetigungsansicht mit Empfaenger,
Betreff und Vorschau; erst deren explizite Bestaetigung ruft den bestehenden
personal- oder workspace-Outbox-Endpunkt mit `expectedVersion` auf.

## Zielarchitektur und API

1. `app/lib/notifications/attention-policy.ts`: reine To-do-/E-Mail-
   Klassifikation und Sortierung, ohne DB-Zugriff oder Mutation.
2. `app/lib/notifications/attention.ts`: kleine Read-Projektionen aus den
   vorhandenen autorisierten To-do- und E-Mail-Read-Models; Auswahl, Limit,
   Deduplizierung und Counts.
3. `app/api/notifications/summary/route.ts`: authentifiziert, loest aktive,
   lesbare, nicht ausgeschlossene Workspaces auf und orchestriert die drei
   Abschnitte einmalig.
4. To-do-, E-Mail- und Mobile-Inbox-Actions bleiben Besitzer ihrer Daten und
   Mutationen. Kein Notification-God-Service und kein zweiter Sendepfad.

Der Vertrag wird additiv eingefuehrt:

```ts
type NotificationSummary = {
  unreadCount: number;
  counts: { unread: number; todoAttention: number; emailAttention: number };
  sections: {
    notifications: NotificationEventItem[];
    todoAttention: TodoAttentionItem[];
    emailAttention: EmailAttentionItem[];
  };
};
```

`items` bleibt nur waehrend der Konsumenten-Migration kompatibel. Neue Clients
verwenden die drei klaren Abschnitte. DTOs enthalten keine E-Mail-Inhalte; der
Server berechnet erlaubte Aktionen und der Sendebefehl validiert trotzdem
erneut alle Rechte und die Version.

## Sequenzielle Umsetzung

1. Ticket-03- und Ticket-14-Vertrag in Abnahme abschliessen; gemeinsame
   Dateigrenzen und Deep-Link-Parameter einfrieren.
2. Policy mit Clock-Input schreiben und isoliert testen.
3. Attention-Read-Projektion bauen und die Summary einmalig daraus bilden;
   keine Migration, keine neue Persistenz.
4. Notification-only-Badge liefern und `mark_all_read` auf Ereignisse
   beschraenken; Legacyfelder klar additiv halten.
5. Web-Glocke: drei Sektionen, Gruende, Vollansichtslinks und frischer
   E-Mail-Review-/Bestaetigungsdialog. Bestehenden Outbox-Pfad wiederverwenden.
6. Startseite auf dieselbe Projektion umstellen; danach separat den
   Mobile-Adapter mit Ticket 03 abgleichen.
7. Erst nach Migration aller Konsumenten kombinierte Alt-Felder und die
   50-To-do-Summary entfernen.

## Tests und manuelle Abnahme

- To-do-Policy: Lifecycle, eigener/zugewiesener/selbst erstellter/fremder
  Team-Fall, Relevanzgruende, stabile Tie-Breaker, Limit und `done => read`.
- E-Mail-Policy: Deduplizierung Fall/Entwurf, Prioritaet, `editing` ohne CTA,
  persoenlicher und Workspace-Scope sowie ausgeschlossene Quellen.
- Summary: Badge ohne To-dos/E-Mails; Bulk-Read aendert keine To-do-States;
  getrennte Counts und Sektionen.
- Outbox: nur aktuelle Version und `canWrite` sendet; 409, parallele
  Reservierung und Sendefehler sind sichtbar und auditierbar.
- Bestehende To-do-, Mobile-Inbox- und E-Mail-Outbox-Tests um die
  Mehr-Workspace-Matrix erweitern; danach Typecheck, Lint und `npm run build`.

Manuell mit persoenlichem, Team- und Projekt-Workspace pruefen: Ausschluesse,
terminales To-do, fremde Zuweisung, Entwurf-Review, Doppelversand-Schutz,
Read-only-Nutzer und korrekte Deep Links. Browser-/Playwright- und reale
Mobile-Tests erfolgen nur nach ausdruecklicher Freigabe.

## Risiken und Integrationsreihenfolge

| Risiko | Gegenmassnahme |
| --- | --- |
| Konflikt mit Ticket 03 in Inbox-Dateien | 03 zuerst abnehmen, dann separater Integrationscommit |
| Zentrum wird wieder Vollansicht | serverseitige Eignung, Limit und Vollansichtslinks |
| Unread, Attention und Lifecycle vermischt | getrennte Felder/Counts, keine generische Bulk-Read-Aktion |
| unautorisierter oder doppelter Versand | frische Detailabfrage; vorhandene Rechte, Version, Reservierung und Audit zwingend |
| Mehr-Workspace-Scope-Leak | nur serverseitig aufgeloeste aktive/lesbare Quellen; Ausschluss vor Query; Zugriffsverlust testen |

Verbindliche Reihenfolge: **02 abgeschlossen -> 03 und 14 abgenommen ->
Ticket 29 Server/Policy -> Web-Glocke und Home -> optional Mobile-Adapter ->
Ticket 20 Agent-/Push-Erweiterung.**
