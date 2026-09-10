# Weitere sinnvolle Tool-Widgets

Stand: 10. September 2026. Bewertung des aktuellen Codes auf Basis von `main`
und der ersten internen Automationskarte. Diese Liste ist priorisiert; die hier
genannten weiteren Karten sind noch nicht implementiert.

## Empfohlene Reihenfolge

| Priorität | Bestehende Tools | Karte und erste Aktionen | Nutzen und vorhandene Anbindung |
| --- | --- | --- | --- |
| 1 | `create_human_todo`, `inspect_human_todo`, `update_human_todo` | Titel, Status, Fälligkeit, Zuständigkeit; **Öffnen**, anschließend **Erledigen** über die bestehenden Todo-Regeln. | Häufiger Abschluss eines Chat-Auftrags. `details.todo` existiert bereits; die Todo-App und das Ereignis `todo_updated` lassen sich wiederverwenden. |
| 2 | `email_create_outbox_draft`, `email_update_outbox_draft` | Betreff, Empfänger, kurzer Textauszug, Anhänge, Prüfstatus; **Entwurf prüfen/bearbeiten**. | Sehr hoher Nutzen vor dem Versand. Die Tools erzeugen bereits prüfbare Entwürfe mit `expectedVersion` und einem `mailboxUiIntent('review-draft')`. Diesen vorhandenen Navigationsweg erweitern. |
| 3 | `public_share_file` mit `create`, `list`, `revoke` | Datei, konkrete öffentliche URL, Ablaufdatum, aktueller Status; **Link kopieren**, **Freigabe verwalten**, später **Widerrufen**. | Sichtbarer Überblick darüber, was tatsächlich veröffentlicht wurde und wann ein Link abläuft. Bestehende Freigabeverwaltung und Berechtigungen nutzen. |
| 4 | `inspect_canvas_plugin`, `create_canvas_plugin_draft`, `install_canvas_plugin_from_workspace`, `update_canvas_plugin_from_workspace`, `set_canvas_plugin_enabled`; entsprechende Skill-Tools | Name, Version, Quelle, Entwurf/installiert/aktiv; **Details öffnen**, **Quelldateien öffnen**. | Hilft beim Prüfen und Installieren eigener Erweiterungen. Der aktuelle Gateway heißt `canvas_extensions`; die Karte muss die tatsächliche Operation erkennen. Installieren/Aktivieren erst über die bestehenden Verwaltungsregeln anbinden. |
| 5 | `trigger_automation_job` | Laufstatus, Startzeit, kurze Ergebniszusammenfassung, vorhandene Ergebnisse; **Lauf öffnen**, **Ergebnis öffnen**. | Passt zur umgesetzten Automationskarte. `details.run` und die bestehenden Laufdetails sind vorhanden. Ein übersprungener Start darf keine falsche Laufkarte erzeugen. |
| 6 | Studio-Aufträge, insbesondere Bulk-Generierung | Auftrag, Fortschritt, Fehler je Element, fertige Dateien; **Auftrag öffnen**, **Ergebnisse öffnen**. | Sinnvoll für länger laufende oder mehrteilige Aufgaben. Bestehende Bild-/Video-/Audio-Vorschauen weiterverwenden; eine zweite Mediengalerie im Widget wäre unnötig. |

**Empfehlung:** Zuerst Todo-Karten, danach E-Mail-Entwürfe und Freigabelinks liefern.
Pro Kartentyp zunächst eine vollständige kleine Funktion inklusive Verlauf,
Berechtigungen und Fehlerzuständen abschließen.

## Grenzen je Kartentyp

- **Todos:** Die Aktion „Erledigen“ kann fachliche Folgen haben, etwa eine
  Fortsetzung im zugeordneten Chat. Deshalb dieselbe Todo-Domain-Aktion nutzen
  und keine Statusspalte direkt ändern. Fremde Aufgaben und Workspacewechsel
  erneut prüfen. Längere Beschreibungen bleiben im bestehenden Editor.
- **E-Mail:** Postfach- und Entwurfsrechte gelten auch beim erneuten Laden.
  Die erste Karte versendet nichts. „Prüfen“ öffnet den vorhandenen Outbox-Editor;
  dessen Versandentscheidung bleibt bestehen. E-Mail-HTML ist untrusted content
  und wird nicht zum ausführbaren Widget-Dokument. Für die kompakte Vorschau
  reichen escaped Text und freigegebene Anhangsmetadaten. Keine vollständigen
  Postfächer oder unnötigen Empfängerlisten in allgemeine Snapshots übernehmen.
- **Öffentliche Links:** Die Karte selbst veröffentlicht keine zusätzlichen
  Dateien. `confirmPublicExposure` und `canCreatePublicLinks` bleiben erforderlich.
  Kopieren/Navigieren erfolgt über begrenzte Canvas-Host-Aktionen, da die Sandbox
  weder allgemeine Clipboard-Rechte noch beliebiges Open-Link erhält. Gelöschte,
  abgelaufene und widerrufene Links müssen vom Server aktuell aufgelöst werden.
- **Plugins/Skills:** Die Vorschau einer Quelle ist keine Ausführungserlaubnis.
  Installationsumfang und tatsächliche Konfiguration prüfen; keine neue
  pauschale Freigabe aus einem historischen Tool-Erfolg ableiten.
- **Läufe/Studio:** Nur sichtbare Karten aktualisieren. Polling und laufende
  Anfragen beim Verlassen beenden; Laden der Historie startet keinen Auftrag.
  Dateizugriff über die bestehenden autorisierten Vorschau-/Downloadpfade
  führen. Die aktuelle iframe-CSP erlaubt keine externen Medienabrufe.

## Was vorerst keine eigene HTML-Karte braucht

- **`read`, Suche, Terminalausgaben, einzelne Dateidiffs:** Bestehende Tool- und
  Dateiansichten reichen aus. Eine Karte soll einen Gegenstand oder eine sinnvolle
  Interaktion abbilden, nicht jedes technische Ergebnis visuell aufblasen.
- **Einzelne erzeugte Bilder, Videos und Dateien:** `FileReferenceCard`,
  `AttachmentPreviewItem` und `ToolOutputView` sind bereits vorhanden. Zusätzliche
  Widgets lohnen sich erst für Status, Auswahl oder einen mehrteiligen Auftrag.
- **OAuth-Verbindungen:** Reconnect-Hinweise und die vorhandene Connection-Health-
  Benachrichtigung bleiben native Host-UI. Für „Verbindung abgelaufen“ ist kein
  ausführbares HTML nötig. Eine spätere Integrationskarte darf nur sichere
  Zustandsdaten zeigen und zur bestehenden Verbindungseinstellung führen.
- **Memory-Tools:** Kein eigener Kartentyp als Standard. Die vorhandene
  Erinnerungsverwaltung ist geeigneter für größere und sensible Einträge.

## Gemeinsamer Implementierungsweg

1. Versionierte Ressourcenreferenz und eine kleine Daten-Allowlist für den
   Kartentyp ergänzen. Keine KI-generierten Skripte oder frei wählbaren HTML-URLs.
2. Erfolgreichen tatsächlichen Tool-Aufruf an die Entität binden; direkte Tools
   und Progressive-Gateway-Aufrufe mit derselben Normalisierung behandeln.
3. Entitäts-, Nutzer-, Chat-, Agent- und Workspace-Rechte beim Laden sowie bei
   jeder Aktion neu prüfen. Persistierte Daten sind kein Berechtigungsnachweis.
4. Den vorhandenen `ToolAppWidget`, die Relay-Sandbox und Canvas-Widget-Bausteine
   nutzen. Den momentan automationstypisierten Daten-/Aktionsadapter um den
   jeweiligen Typ erweitern; keine zweite Bridge oder Sandbox einführen.
5. Bestehende fachliche Aktionen mit Versionsprüfung wiederverwenden. Nutzeraktionen
   nachvollziehbar speichern, ohne bei einem bloßen Refresh einen Modelllauf zu starten.
6. Live-/Verlaufswechsel, doppelte Events, Rechteentzug, Löschung, mobile Breite,
   Tastatur und Grenzen für aktive Frames vor Freigabe prüfen.

## Geprüfte Codegrundlagen

- [Todo-Tools](../../../app/lib/pi/human-todo-tool.ts),
  [Todo-API](../../../app/api/todos/[id]/route.ts)
- [E-Mail-Tools](../../../app/lib/pi/workspace-email-tools.ts),
  [persönliche Outbox-API](../../../app/api/email/outbox/[draftId]/route.ts),
  [Workspace-Outbox-API](../../../app/api/workspaces/[id]/email/outbox/[draftId]/route.ts)
- [Freigabe-, Plugin-, Skill- und Automationstools](../../../app/lib/pi/scoped-tools.ts),
  [Freigabe-API](../../../app/api/security/public-shares/[id]/route.ts)
- [Progressive Gateways](../../../app/lib/pi/progressive-tool-gateway.ts),
  [Studio-Tools](../../../app/lib/pi/studio-tools.ts)
- [Bestehende Tool-Vorschauen](../../../app/components/canvas-agent-chat/ToolOutputView.tsx),
  [Nachrichtenverlauf](../../../app/components/canvas-agent-chat/ChatMessageList.tsx)
- [Umsetzungsplan](tool-widgets-plan.md), [Sicherheitsmodell](../../security/mcp-apps.md)
