---
title: Canvas Notebook — Bradley und Canvas Host Agent Terminologievertrag
status: decided
todo_id: BRADLEY-006
decision_date: 2026-09-02
owners:
  - Canvas Notebook
tags:
  - agent
  - architecture
  - brand
  - control-plane
  - terminology
---

# Canvas Notebook — Bradley und Canvas Host Agent Terminologievertrag

## Verbindliche Entscheidung

Die beiden bisher leicht verwechselbaren Agentenrollen erhalten eindeutig
getrennte Namen:

- **Bradley** ist der sichtbare Hauptagent innerhalb von Canvas Notebook.
- **Canvas Host Agent** ist der technische Dienst auf einer verwalteten
  VM, der den Host mit der Canvas Control Plane verbindet.
- **`bradley`** ist die kanonische interne ID des Notebook-Hauptagenten.
- **`canvas-agent`** bleibt als Legacy-Alias und in bestehenden technischen
  Infrastrukturpfaden erhalten, ist aber keine neue Hauptagenten-ID.

Die unqualifizierte Bezeichnung **Canvas Agent** wird in neuer Produkt-,
Support- und Architektursprache nicht mehr verwendet. Sie ist zu mehrdeutig,
weil sie historisch sowohl den Notebook-Hauptagenten als auch den Host-Dienst
bezeichnet hat.

## Rollenabgrenzung

| Merkmal | Bradley | Canvas Host Agent |
| --- | --- | --- |
| Ort | innerhalb der Canvas-Notebook-Anwendung und Agent-Runtime | als systemd-Dienst auf dem VM-Host, außerhalb des Notebook-Containers |
| Zielgruppe | Nutzer, die im Workspace arbeiten | Administratoren und die Canvas Control Plane |
| Aufgabe | mit Dateien, Projekten, Tools, Modellen und Workflows arbeiten | Host- und Docker-Metriken melden sowie erlaubte Betriebsbefehle ausführen |
| Kommunikation | Chat, Onboarding, Agent-Auswahl, Status und Deliverables | Machine-to-Machine-Verbindung, Betriebsstatus, Audit-Log und VM-Verwaltung |
| Sichtbarer Name | Bradley | Canvas Host Agent |
| Technische Bezeichner | Hauptagent-ID `bradley`; Legacy-Alias `canvas-agent` | bestehende Service-, Pfad-, Paket-, Tabellen- und Protokollnamen bleiben unverändert |
| Visuelles Zeichen | Bradley-Glyph beziehungsweise Character | neutrales technisches Infrastruktur-Icon; niemals Bradley-Glyph |
| Verfügbarkeit | Bestandteil von Canvas Notebook | nur vorhanden, wenn die Installation durch eine Control Plane verwaltet wird |
| Verantwortung | arbeitet innerhalb der effektiven Notebook-Fähigkeiten | führt ausschließlich erlaubte Host-/CLI-Aktionen im Control-Plane-Kontext aus |

## Kanonische Bezeichnungen

### Deutsch

| Kontext | Bezeichnung |
| --- | --- |
| Hauptagent in UI und Marketing | `Bradley` |
| erklärende erste Nennung | `Bradley, der Hauptagent von Canvas Notebook` |
| technischer VM-Dienst in UI und Support | `Canvas Host Agent` |
| erklärende erste Nennung | `Canvas Host Agent, der technische Verwaltungsdienst auf der VM` |
| zentrale Verwaltungsplattform | `Canvas Control Plane` |
| interne Hauptagent-ID | `` `bradley` `` |
| Legacy-Hauptagent-ID | `` `canvas-agent` `` |

### Englisch

| Context | Term |
| --- | --- |
| Main agent in UI and marketing | `Bradley` |
| Explanatory first mention | `Bradley, the main agent in Canvas Notebook` |
| Technical VM service in UI and support | `Canvas Host Agent` |
| Explanatory first mention | `Canvas Host Agent, the technical management service running on the VM` |
| Central management platform | `Canvas Control Plane` |
| Internal main-agent ID | `` `bradley` `` |
| Legacy main-agent ID | `` `canvas-agent` `` |

`Canvas Host Agent` bleibt in deutschen Texten als Produktkomponentenname
englisch. Falls zusätzliche Erklärung nötig ist, folgt „technischer
Host-Dienst“ oder „Verwaltungsdienst auf der VM“.

## Technische ID-Migration und stabile Infrastrukturbezeichner

Seit 2026-09-02 wird die Notebook-Hauptagent-ID kontrolliert von
`canvas-agent` auf `bradley` migriert. Neue Daten, API-Ausgaben und mobile
Requests verwenden `bradley`. Eingehende Legacy-Werte werden weiterhin
akzeptiert und auf `bradley` normalisiert.

Unverändert bleiben davon getrennte Infrastrukturverträge, insbesondere:

- der Canvas-Host-Agent und seine Service-, Paket- und Protokollnamen;
- der globale Runtime-Pfad `/data/canvas-agent`;
- historische Exportformate und Migrationsquellen mit `canvas-agent`;
- bestehende systemd-, Paket-, Repository-, Tabellen- und WebSocket-Bezeichner
  des Host-Dienstes;
- Canvas CLI und ihre erlaubten Betriebsaktionen;
- UI-Komponentenordner, deren Umbenennung keinen Produktnutzen erzeugt.

Bestehende Notebook-Datenbankreferenzen und nutzerbezogene Agentenpfade werden
rollback-sicher migriert. Die alte Dateikopie bleibt dabei erhalten. Details
und Abnahmekriterien stehen in der
[Bradley Agent-ID-Migration](./bradley-agent-id-migration.md).

In technischen Dokumenten dürfen diese Literalwerte exakt genannt werden,
wenn ihre Funktion erläutert wird. Sie werden aber nicht als sichtbarer
Produktname kapitalisiert oder in Marketing-Copy übernommen.

## Regeln pro Oberfläche

Die vollständige Zuordnung aller Agenten-, E-Mail-, Automations-, Tool- und
Systemkontexte ist in der
[Bradley Agenten- und Oberflächenkontextmatrix](./bradley-agent-context-matrix.md)
festgelegt. Die folgende Tabelle konkretisiert insbesondere die Trennung vom
Canvas Host Agent.

| Oberfläche | Regel | Beispiel |
| --- | --- | --- |
| Chat-Header und Agent-Auswahl | Hauptagent ausschließlich Bradley nennen | `Bradley` |
| Onboarding | Rolle von Bradley erklären, keinen Host-Agenten erwähnen, wenn er für den Ablauf irrelevant ist | „Das ist Bradley, dein Hauptagent in Canvas Notebook.“ |
| Agent-Einstellungen | sichtbaren Namen Bradley von interner ID trennen | `Bradley · Interne ID: bradley` nur in technischer Detailansicht |
| Control-Plane-VM-Ansicht | Verbindungszustand dem Canvas Host Agent zuordnen | „Canvas Host Agent ist offline.“ |
| Host-Metriken | Quelle als Canvas Host Agent oder VM kennzeichnen | „Vom Canvas Host Agent zuletzt vor 30 Sekunden gemeldet.“ |
| Betriebsbefehl | ausführenden Infrastrukturpfad nennen | „Neustart über den Canvas Host Agent ausgeführt.“ |
| Notebook-Runtime-Fehler | Bradley nur nennen, wenn tatsächlich der Hauptagent betroffen ist | „Bradley konnte die Datei nicht öffnen.“ |
| Support-Dokumentation | beim ersten Auftreten Rolle und Ort erklären | „Der Canvas Host Agent läuft als Dienst auf der VM.“ |
| Audit-Log | tatsächlichen Akteur und Zielsystem zeigen | „Canvas Host Agent · `canvas-notebook restart` · abgeschlossen“ |

## Verbotene oder missverständliche Formulierungen

| Nicht verwenden | Grund | Verwenden |
| --- | --- | --- |
| „Canvas Agent“ ohne Qualifizierung | historisch mehrdeutig | Bradley oder Canvas Host Agent |
| „Bradley ist auf der VM offline“ bei unterbrochenem Control-Plane-Tunnel | ordnet einen Infrastrukturzustand der Figur zu | „Canvas Host Agent ist offline.“ |
| „Bradley hat den Server neu gestartet“ | verschleiert den technischen Ausführungspfad | „Der Neustart wurde über den Canvas Host Agent ausgeführt.“ |
| „Canvas Host Agent beantwortet deine Fragen“ | verwechselt Host-Dienst mit Hauptagent | „Bradley beantwortet deine Fragen.“ |
| Bradley-Glyph neben CPU-, RAM- oder Docker-Metriken | vermischt Produktfigur und Infrastruktur | neutrales Host-/Server-Icon |
| „Control Plane Bradley“ oder „Bradley Host Agent“ | erzeugt eine nicht existierende Produktrolle | Canvas Host Agent |

## Status- und Fehlersemantik

Die Zustände der beiden Rollen dürfen nicht voneinander abgeleitet werden:

- Ein offline gemeldeter Canvas Host Agent bedeutet nicht automatisch, dass
  Bradley oder Canvas Notebook für lokale Nutzer nicht verfügbar ist.
- Ein nicht erreichbarer Bradley-Chat bedeutet nicht automatisch, dass der
  Canvas Host Agent oder die VM offline ist.
- Ein erfolgreicher Host-Befehl belegt nicht, dass eine fachliche Aufgabe von
  Bradley erfolgreich abgeschlossen wurde.
- Self-Hosted-Installationen können Bradley verwenden, ohne einen Canvas Host
  Agent installiert zu haben.

Statusmeldungen nennen daher immer Subjekt, Zustand und gegebenenfalls den
letzten bekannten Zeitpunkt. Fehler nennen zusätzlich Auswirkung und nächste
Aktion.

## Architektur- und Supportformulierung

Freigegebene Kurzbeschreibung:

> Bradley ist der Hauptagent, mit dem Nutzer innerhalb von Canvas Notebook
> arbeiten. Der Canvas Host Agent ist ein separater technischer Dienst auf
> verwalteten VMs. Er verbindet den Host mit der Canvas Control Plane, meldet
> Betriebsdaten und führt eng begrenzte Verwaltungsaktionen aus.

Freigegebene englische Fassung:

> Bradley is the main agent users work with inside Canvas Notebook. The Canvas
> Host Agent is a separate technical service on managed VMs. It connects the
> host to the Canvas Control Plane, reports operational data, and executes a
> limited set of management actions.

## Migrations- und Review-Regeln

Bei der späteren Copy- und UI-Migration wird jeder Treffer von `Canvas Agent`
klassifiziert:

1. sichtbarer Hauptagent → `Bradley`;
2. technischer VM-Dienst → `Canvas Host Agent`;
3. Notebook-Hauptagent-ID → kanonisch `bradley`, Legacy-Eingaben normalisieren;
4. Host-Agent-, globaler Runtime-, Export- oder historischer Pfad → unverändert lassen;
5. Sammelbegriff für mehrere Agenten → präzisieren, zum Beispiel
   `Canvas-Notebook-Agenten` oder `verfügbare Agenten`;
6. historisches Zitat oder Migrationshinweis → als historisch kennzeichnen.

Eine automatische globale Textersetzung ist unzulässig, weil `canvas-agent`
in beiden Systemen als technischer Altbezeichner vorkommen kann. Die sichtbare
Migration wird in BRADLEY-034, BRADLEY-035 und BRADLEY-053 anhand dieser
Klassifikation umgesetzt.

## Abschluss BRADLEY-006

BRADLEY-006 ist abgeschlossen. Bradley, Canvas Host Agent, Canvas Control Plane,
die kanonische ID `bradley` und der Legacy-Alias `canvas-agent` besitzen
getrennte Rollen, kanonische DE-/EN-Bezeichnungen, UI-Regeln, Statussemantik
und Migrationskriterien.
