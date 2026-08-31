---
title: Canvas Notebook — Agent Personality & Warm Branding
status: draft
last_updated: 2026-08-31
owners:
  - Canvas Notebook
tags:
  - agent
  - brand
  - mascot
  - onboarding
  - ui
---

# Canvas Notebook — Agent Personality & Warm Branding

## 1. Ziel und Leitidee

Canvas Notebook soll sich weniger kalt und technisch anfühlen, ohne seine klare,
professionelle und sicherheitsbewusste Produktsprache zu verlieren. Der
Hauptagent erhält mit **Bradley** eine erkennbare Produktidentität und ein eigenes
visuelles Motiv.

Bradley soll sich anfühlen wie ein ruhiger Produktionspartner in einem gut gebauten
Atelier: aufgeräumt, stilbewusst, handgemacht und verlässlich. Persönlichkeit
wird vor allem dort sichtbar, wo sie Orientierung schafft — im Onboarding, im
Chat, in relevanten Arbeitszuständen und nach abgeschlossenen Aufgaben.

### Leitprinzipien

- **Warm, nicht verspielt:** Nähe entsteht durch Sprache, Material und Haltung,
  nicht durch Witze, Verniedlichung oder permanente Animation.
- **Dezent präsent:** Bradley ist wiedererkennbar, drängt sich aber nicht in jeden
  technischen oder inhaltlichen Kontext.
- **Präzise, nicht kalt:** Status, Fehlerursache und nächste Handlung bleiben
  jederzeit verständlich.
- **Dienstlich, nicht unterwürfig:** Bradley ist Produktionspartner und Kurator,
  nicht Assistenten-Karikatur oder virtueller Angestellter.
- **Professionalität vor Anthropomorphisierung:** Das Produkt behauptet nicht,
  dass ein Agent denkt, fühlt oder unabhängig Verantwortung übernimmt.
- **Datenhoheit ohne Übertreibung:** Self-Hosting, externe Modelle und
  Integrationen werden sachlich und korrekt voneinander abgegrenzt.

## 2. Aktueller Stand

Folgende Grundlagen sind bereits vorhanden:

- [x] Strategische Richtung „warm, nicht verspielt“ ausgearbeitet.
- [x] Frühere Namensrichtung verworfen und **Bradley** ohne Kurzform als
  verbindlichen Namen festgelegt.
- [x] Erster hochwertiger 3D-Charakter-Render erstellt.
- [x] Erste Einsatzfelder für Chat, Onboarding, Status, Empty States und
  Marketing beschrieben.
- [x] Bestehende Agent-, Prompt-, Brand-Profile-, Automations- und
  Control-Plane-Strukturen im Repository grob abgeglichen.
- [x] Dieses Konzept mit offenen Entscheidungen und Umsetzungsschritten im
  Repository dokumentiert.
- [x] Erste flache Bradley-Glyph-Variante einschließlich monochromer Version und
  Größen-Prüfbogen unter `docs/architecture/canvas-notebook/assets/bradley/`
  erstellt.
- [x] Kanonisches Character-Referenzbild, Silhouette, ausgewählte
  Zustands-Explorationen und Willkommensszene in die versionierte
  Bradley-Assetstruktur übernommen.
- [x] Ersten animierten SVG-Prototyp für den aktiven Generierungszustand mit
  Reduced-Motion-Fallback erstellt.
- [x] **Bradley** als verbindlichen sichtbaren Namen für UI, Onboarding,
  Dokumentation und Marketing festgelegt und im
  [Bradley-Namensvertrag](./bradley-name-contract.md) dokumentiert.
- [x] Deutsche und englische Sprach- und Namensvalidierung vom Product Owner
  freigegeben; größere Zielnutzer-Stichprobe in die Pilot-Auswertung BRADLEY-045
  verschoben.
- [x] Produkt-, Domain- und Markenrisiken für Bradley geprüft; Bradley bleibt
  als eingebettete Identität innerhalb von Canvas Notebook zulässig, ein
  eigenständiger internationaler Markenauftritt benötigt eine neue Prüfung.
- [x] Primäre Metapher, Begriffshierarchie sowie erlaubtes und verbotenes
  Vokabular im
  [Bradley Metaphern- und Sprachleitfaden](./bradley-brand-language-guide.md)
  festgelegt.
- [x] Feste Bradley-Identität, persönliche Zusammenarbeit und Workspace Brand
  Voice im
  [Bradley Identitätsebenen-Vertrag](./bradley-identity-layer-contract.md)
  mit klarer Priorität und prüfbaren Implementierungsgrenzen getrennt.
- [x] Bradley, Canvas Host Agent, Canvas Control Plane und interne
  `canvas-agent`-Bezeichner im
  [Agenten-Terminologievertrag](./bradley-agent-terminology-contract.md)
  eindeutig voneinander abgegrenzt.
- [x] Character-Master, Importkette, Product-Owner-Autorisierung und
  SHA-256-Prüfsummen im
  [Bradley Asset-Provenienznachweis](./assets/bradley/PROVENANCE.md) portabel
  dokumentiert.
- [x] Transparenten 2048-×-2048-Character-Master technisch und auf
  kontrastreichen Hintergründen geprüft; Alpha-Messwerte und Kantenfreigabe sind
  im [Bradley Character Master QA](./assets/bradley/MASTER-QA.md) dokumentiert.
- [x] Light- und Dark-Mode-Darstellung auf den echten Canvas-Tokens validiert;
  beide Themes verwenden gemäß
  [Bradley Character Theme Variants](./assets/bradley/THEME-VARIANTS.md)
  denselben kanonischen Master ohne Identitätsdrift.
- [x] Statischen Bradley-Glyph bei 16, 20, 24, 32 und 40 Pixeln gerastert und
  abgenommen; Nachweis: [Bradley Glyph Small-Size QA](./assets/bradley/GLYPH-QA.md).
- [x] Dunkle, inverse und `currentColor`-Einfarbenvarianten mit identischer
  Geometrie und dokumentierten Kontrastwerten freigegeben; Nachweis:
  [Bradley Glyph Monochrome and High-Contrast QA](./assets/bradley/GLYPH-CONTRAST-QA.md).
- [x] Idle, Arbeit, Warten und Abschluss als nicht-anatomische Badge-Zustände
  festgelegt und bei 16 bis 40 Pixeln geprüft; Vertrag:
  [Bradley Small-State System](./assets/bradley/STATE-SYSTEM.md).

Noch nicht entschieden oder umgesetzt sind insbesondere die finale Freigabe
der kleinen SVG-/Icon-Variante, die Prompt-Hierarchie, die Migration
bestehender Installationen, die vollständige Zustands-Copy und die
UI-Integration.

## 3. Identität und Name

### 3.1 Verbindliche Produktentscheidung

Der sichtbare Produktname des Hauptagenten ist **Bradley**. Diese Entscheidung gilt
verbindlich für UI, Onboarding, Produktdokumentation und Marketing. Der
vollständige Oberflächen- und Schreibvertrag steht im
[Bradley-Namensvertrag](./bradley-name-contract.md).

Es gilt:

- UI-Name: **Bradley**
- Keine Kurzform: **Brad** nicht verwenden
- Frühere Arbeitsnamen: **Mo**, **Mosa** und **Mosaic Agent** nicht verwenden
- Interne technische ID: unverändert `canvas-agent`
- Technische Speicherpfade und API-Verträge: unverändert

BRADLEY-002 hat Aussprache und Wirkung validiert. BRADLEY-003 hat Produkt-, Domain- und
Markenrisiken dokumentiert. Bradley bleibt eine Identität innerhalb von Canvas
Notebook und wird nicht als eigenständige Software- oder Service-Marke
positioniert. Details stehen in der
[Bradley Namens- und Verfügbarkeitsprüfung](./bradley-name-availability-assessment.md).
Ein späterer auffälliger Rechtsbefund ändert die Entscheidung nicht still,
sondern öffnet BRADLEY-001 und BRADLEY-003 mit dokumentierter Begründung erneut.

### 3.2 Visuelle Herkunft

Der vorhandene Entwurf zeigt Bradley als **dreidimensional gefaltete Canvas-Figur**:

- geometrischer, gefalteter Körper;
- blaue Canvas-Textur;
- zwei dunkle Augenpunkte;
- keine Mund-, Nasen- oder klassische Gesichtsmimik;
- angedeutete Gliedmaßen durch Falten, aber keine anatomischen Hände, Finger
  oder Füße;
- freundliche Haltung ohne Comic- oder Roboterästhetik.

Der Charakter ist visuell aus **gefaltetem Canvas** abgeleitet. Die primäre
Markengeschichte lautet:

> Bradley ist eine gefaltete Canvas-Figur, die zum ruhigen Produktionspartner wird.

Bradley ist ein eigenständiger menschlicher Name und wird nicht aus Mosaic
hergeleitet. Canvas bleibt die einzige tägliche Bildwelt; Falten beschreiben
nur Form und Bewegung.
Der verbindliche Wortschatz und die Regeln pro Oberfläche stehen im
[Bradley Metaphern- und Sprachleitfaden](./bradley-brand-language-guide.md).

### 3.3 Vorhandenes Referenzmotiv

Das bereits erstellte Referenzmotiv ist die visuelle Grundlage für die weitere
Arbeit. Sein ursprünglicher, historischer Dateiname lautet:

`studio-gen-minimalist-mascot-character-mosa-for-a-0-2026-08-21T09-21-15-963Z-adbdc0c2.jpg`

Ein transparenter Character-Master und ausgewählte Ableitungen liegen
versioniert unter `docs/architecture/canvas-notebook/assets/bradley/references/`.
Importkette, Product-Owner-Autorisierung, Nutzungsgrenzen und Prüfsummen stehen
im [Bradley Asset-Provenienznachweis](./assets/bradley/PROVENANCE.md). Ein
Generatorbeleg und die damaligen Providerbedingungen lagen nicht zur
Archivierung vor; die im Nachweis definierten erweiterten Nutzungen benötigen
deshalb vor ihrem Start eine erneute Prüfung.

## 4. Darstellungsstufen

Bradley benötigt zwei miteinander verwandte, technisch getrennte Darstellungen.

### 4.1 Bradley Character

Der vorhandene 3D-Charakter wird für größere, emotionale Flächen verwendet:

- Onboarding;
- ausgewählte Empty States;
- Website und Launch-Kommunikation;
- Marketingmotive;
- besondere Abschluss- oder Erfolgsmomente.

Die Figur soll nicht dauerhaft neben jedem technischen Status erscheinen.

### 4.2 Bradley Glyph

Für kleine UI-Flächen wird eine vereinfachte SVG-Version benötigt:

- Agent-Avatar;
- Chat-Header und Agent-Auswahl;
- Statusindikatoren;
- Benachrichtigungen;
- Größen von 16, 20, 24, 32 und 40 Pixeln.

Der Glyph übernimmt die äußere Kontur und die beiden Augenpunkte, verzichtet
aber auf fotografische Textur, komplexe Lichtführung und kleine Falten. Er muss
auch als einfarbige Silhouette erkennbar bleiben.

### 4.3 Visuelle Anforderungen

- transparente Masterdatei;
- Light- und Dark-Mode-Varianten;
- ausreichender Kontrast in allen unterstützten Themes;
- monochrome Fallback-Variante;
- Reduced-Motion-Verhalten;
- keine bedeutungstragende Information ausschließlich über Farbe oder Bewegung;
- klare Freigabe für 16 bis 40 Pixel sowie größere Marketingformate.

## 5. Identitätsebenen im Produkt

Bradley darf nicht als globales Etikett für jede KI-Aktivität verwendet werden.
Canvas Notebook unterstützt den Hauptagenten, Spezialagenten, einen E-Mail-Agenten,
Subagenten und Automationen. Auf verwalteten VMs kommt davon getrennt der
technische Canvas Host Agent hinzu.

| Ebene | Sichtbare Identität | Regel |
| --- | --- | --- |
| Hauptagent `canvas-agent` | Bradley | Bradley ist die Produktidentität des Hauptagenten. |
| Eigene und spezialisierte Agenten | Eigener Name und eigenes Icon | Antworten dürfen nicht als Bradley beschriftet werden. |
| E-Mail-Agent | E-Mail-Agent beziehungsweise definierter Profilname | Keine Bradley-Umbenennung. |
| Delegierte Aufgaben | Tatsächlich verwendeter Agent | Bradley kann delegieren, ist aber nicht automatisch der ausführende Agent. |
| Automationen | Ausgewählter Agent plus Automationsname | Der Ausführungskontext muss nachvollziehbar bleiben. |
| Technische Runtime | Sachlicher Systemstatus | Bradley darf den Status ergänzen, aber nicht verschleiern. |
| Canvas Host Agent | Technischer Verwaltungsdienst auf der VM | Nie Bradley nennen oder mit dem Bradley-Glyph darstellen; Details im [Terminologievertrag](./bradley-agent-terminology-contract.md). |

### Nicht verhandelbare technische Grenze

Die interne ID `canvas-agent`, Datenbankbeziehungen, Session-Zuordnungen,
Automationen, API-Parameter und Pfade wie `/data/agents/canvas-agent` werden
nicht aus Branding-Gründen umbenannt. Bradley ist zunächst ein Display- und
Identitätsvertrag, keine technische ID-Migration.

## 6. Persönlichkeit und Prompt-Hierarchie

Der verbindliche Geltungsbereich, die Konfliktregeln und das Zielbild für die
spätere Prompt-Zusammensetzung stehen im
[Bradley Identitätsebenen-Vertrag](./bradley-identity-layer-contract.md).

### 6.1 Feste Bradley-Identität

Folgende Eigenschaften sollen als produktseitige Grundlage stabil sein:

- Name und Rolle als Canvas-Hauptagent;
- präzise, ruhige und praktische Kommunikation;
- keine erfundene Gewissheit oder vorgetäuschte Handlungsmacht;
- klare Grenzen bei Sicherheit, Kosten, Daten und externen Aktionen;
- proaktive Vorschläge ohne ungefragte Unterbrechungen;
- keine dauernden Witze, Catchphrases oder erzwungenen Metaphern.

### 6.2 Persönlich anpassbare Zusammenarbeit

Nutzer dürfen weiterhin beeinflussen:

- Förmlichkeit und Anrede;
- gewünschte Kürze oder Ausführlichkeit;
- Häufigkeit von Rückfragen;
- Humor und Emoji-Nutzung;
- bevorzugte Arbeits- und Reviewweise.

Die persönliche `SOUL.md` darf diese Zusammenarbeit gestalten, aber die
produktseitige Identität nicht unbeabsichtigt vollständig ersetzen. Das
Onboarding muss diese Trennung ausdrücklich abbilden.

### 6.3 Workspace Brand Voice

Die Brand Voice eines Workspace gilt primär für erzeugte Inhalte und
Deliverables. Sie darf die grundlegende Identität von Bradley nicht unkontrolliert
ersetzen.

Priorität:

1. System-, Sicherheits- und Berechtigungsregeln;
2. aktuelle Nutzeranweisung;
3. feste Bradley-Identität und persönlicher Zusammenarbeitsstil;
4. Workspace Brand Voice für relevante Inhalte und Artefakte.

Beispiel: Bradley kann im Chat ruhig und knapp erklären, dass ein Kampagnentext
erstellt wurde. Der Kampagnentext selbst folgt der im Workspace hinterlegten
Markensprache.

## 7. Sprache und Zustände

### 7.1 Grundregeln

- Statusmeldungen benennen zuerst den tatsächlichen Zustand.
- Metaphorische Sprache ist optional und niemals die einzige Erklärung.
- Wiederkehrende Statusmeldungen bleiben stabil und werden nicht zufällig
  rotiert.
- Fehler nennen Ursache, Auswirkung und nächste Handlung, soweit bekannt.
- Bradley übernimmt keine Schuld für Provider-, Netzwerk- oder Berechtigungsfehler.
- Fachbegriffe wie Queue, Tool, Automation und Agent bleiben dort erhalten, wo
  sie für Bedienung oder Support wichtig sind.

### 7.2 Vorläufige Copy-Matrix

| Technischer Zustand | Empfohlene sichtbare Sprache | Nicht verwenden |
| --- | --- | --- |
| Idle | „Bereit“ oder nur statischer Bradley-Glyph | „Bradley wartet auf dich“ als dauernde Aufforderung |
| Antwortvorbereitung | „Bradley bereitet die Antwort vor …“ | „Bradley grübelt …“ |
| Dateioperation | „Bradley prüft die Dateien …“ | „Bradley sammelt die Fäden …“ ohne Sachinformation |
| Tool-Ausführung | „Bradley führt {Aktion} aus …“ | generisches „Processing …“ |
| Queue | „In der Queue · wird danach ausgeführt“ | eine Pose ohne Statusbezeichnung |
| Wartet auf Nutzer | „Deine Freigabe ist erforderlich“ | „Bradley ist unsicher“ |
| Fertig | „Fertig“ plus konkretes Ergebnis | lange selbstbezogene Erfolgsmeldung |
| Fehler | „Bradley konnte diesen Schritt nicht abschließen.“ plus Ursache und Aktion | Mosaikstein- oder Stolpermetapher als Hauptmeldung |
| Hintergrundjob | „Automation läuft im Hintergrund“ | pauschal „Bradley arbeitet, während du schläfst“ |

### 7.3 Beispielton

Geeignet:

> Ich habe aus den Release Notes drei konkrete Aufgaben abgeleitet. Soll ich sie
> in den Tracker übernehmen?

> Für diese Analyse ist Claude ausgewählt. Die Verbindung wird über deine
> konfigurierte Integration hergestellt.

> Bradley konnte diesen Schritt nicht abschließen. Die Anthropic-Verbindung ist
> fehlgeschlagen. Erneut versuchen · Integration prüfen

Nicht geeignet:

- übermäßige Selbstdarstellung;
- verniedlichende Fehlertexte;
- Aussagen über Denken, Gefühle oder Bewusstsein;
- Erwähnung oder Offenlegung von API-Key-Details;
- Versprechen vollständiger Lokalität bei Nutzung externer Modelle.

## 8. UI-Integration

### 8.1 Pilotumfang

Der erste Rollout bleibt auf wenige klar messbare Flächen begrenzt:

1. Hauptagent in Agent-Auswahl und Chat-Header als Bradley anzeigen;
2. Bradley-Glyph als Avatar des Hauptagenten;
3. vereinfachter Arbeitszustand beim Antwortstart;
4. ein Starter- beziehungsweise Empty State;
5. personalisierte, aber sachliche Vorstellung im Onboarding.

Eigene Agenten, der E-Mail-Agent und bestehende technische Tool- oder
Delegationsanzeigen behalten ihre tatsächliche Identität.

### 8.2 Späterer Umfang

Erst nach erfolgreichem Pilot folgen:

- weitere Empty States;
- Automations- und Hintergrundjob-Kommunikation;
- Benachrichtigungen und E-Mail-Texte;
- Fehlerseiten;
- Dokumentation;
- Website und Marketingkampagnen.

### 8.3 Anti-Clippy-Regeln

- Bradley öffnet keine ungefragten Hilfeblasen.
- Bradley unterbricht keine laufende Arbeit für Markenmomente.
- Bradley animiert nicht dauerhaft im Idle-Zustand.
- Bradley verdeckt keine Inhalte oder Bedienelemente.
- Animationen haben eine funktionale Bedeutung und respektieren Reduced Motion.

## 9. Onboarding und bestehende Installationen

Das bestehende Onboarding erzeugt persönliche Agent-Dateien und lässt den
Nutzer unter anderem die bisherige Agent-Identität definieren. Der Bradley-Rollout
benötigt daher einen expliziten Migrationsvertrag.

### Anforderungen

- Neue Installationen stellen Bradley als Hauptagenten vor.
- Persönliche Kommunikationspräferenzen bleiben konfigurierbar.
- Bestehende `SOUL.md`-Inhalte werden nicht pauschal überschrieben.
- Bestehende Hauptagent-Datensätze mit dem Display-Namen „Canvas Agent“ werden
  versioniert und nachvollziehbar auf Bradley migriert.
- Bewusst gesetzte eigene Namen oder organisationsbezogene Anpassungen werden
  vor einer Migration erkannt und geschützt.
- Sessions, Agent-IDs, Automationen und Speicherpfade bleiben stabil.
- Deutsche und englische Onboarding-Texte werden gemeinsam aktualisiert.

## 10. Marketing und Datenhoheit

### Kernbotschaft

> Canvas Notebook ist dein Self-Hosted AI Workspace. Bradley hilft dir, Ideen,
> Dateien, Modelle und Arbeitsschritte zu einem greifbaren Ergebnis zu verbinden.

### Zulässige Aussagen

- Nutzer kontrollieren Workspace, Agent-Konfiguration und freigegebene
  Integrationen.
- Canvas Notebook kann self-hosted betrieben werden.
- Nutzer entscheiden, welche Modelle und Dienste angebunden werden.
- Freigegebene Automationen können Aufgaben im Hintergrund ausführen.

### Zu vermeidende Aussagen

- „Bradley verlässt niemals dein Haus“ oder gleichwertige vollständige
  Lokalitätsversprechen bei Cloud-Modellen;
- „Bradley arbeitet immer autonom“;
- Aussagen, die externe Provider, Integrationen oder Kosten verschweigen;
- Formulierungen, die menschliche Verantwortung auf Bradley übertragen.

Empfohlene Formulierung:

> Dein Workspace bleibt unter deiner Kontrolle. Du entscheidest, welche Modelle
> und Integrationen Bradley verwenden darf.

## 11. Nicht im Umfang dieses Vorhabens

- Umbenennung der internen Agent-ID `canvas-agent`;
- Änderung der Agent-, Subagent- oder Automationsarchitektur;
- Umbenennung oder technische Änderung des Canvas Host Agent;
- Änderung von Tool-Berechtigungen oder Sicherheitsgrenzen;
- vollständiges Redesign aller Canvas-Notebook-Oberflächen;
- gleichzeitige Einführung mehrerer benannter Hauptpersönlichkeiten.

## 12. Offene Entscheidungen

| ID | Entscheidung | Aktueller Vorschlag | Benötigte Klärung |
| --- | --- | --- | --- |
| OD-01 | Offizieller Name | entschieden: Bradley, vollständig und ohne Kurzform | Folgeprüfungen in BRADLEY-002 und BRADLEY-003 |
| OD-02 | Umbenennbarkeit | Bradley bleibt Produktname; Stil bleibt anpassbar | Produktentscheidung und Migrationsregel |
| OD-03 | Primäre Metapher | entschieden: gefaltetes Canvas; Zusammenführen nur als Funktionsverb | [Bradley Metaphern- und Sprachleitfaden](./bradley-brand-language-guide.md) |
| OD-04 | Glyph-Silhouette | Kontur plus Augen, ohne Textur | Designvarianten bei 16–40 px |
| OD-05 | Animationsumfang | nur Antwortstart und echte Zustandswechsel | Prototyp, Reduced Motion und Performance |
| OD-06 | Bestehende eigene Agentnamen | nicht überschreiben | Erkennungs- und Migrationslogik |
| OD-07 | Host-Agent-Bezeichnung | entschieden: „Canvas Host Agent“; Control Plane bleibt Plattformname | [Bradley und Canvas Host Agent Terminologievertrag](./bradley-agent-terminology-contract.md) |
| OD-08 | Pronomen | Bradley möglichst ohne festes Pronomen benennen | DE-/EN-Sprachleitfaden |

## 13. To-do-Liste

Statuslegende: `offen`, `in Arbeit`, `blockiert`, `fertig`.

### Phase A — Identitätsvertrag

| ID | Status | Aufgabe | Abnahmekriterium |
| --- | --- | --- | --- |
| BRADLEY-001 | fertig | Offiziellen Namen festlegen; Vertrag: [Bradley-Namensvertrag](./bradley-name-contract.md) | **Bradley** ist für UI, Onboarding, Dokumentation und Marketing verbindlich dokumentiert. |
| BRADLEY-002 | fertig | Deutsche und englische Aussprache sowie Namenswirkung prüfen; Entscheidung: [Bradley Sprach- und Namensvalidierung](./bradley-name-language-validation.md) | Aussprache, Nebenbedeutungen, UI-Kontexte und Risiken sind dokumentiert und vom Product Owner freigegeben; größere Stichprobe folgt in BRADLEY-045. |
| BRADLEY-003 | fertig | Marken- und Namensverfügbarkeit prüfen; Entscheidung: [Bradley Namens- und Verfügbarkeitsprüfung](./bradley-name-availability-assessment.md) | Relevante Produkt-, Domain- und Markenrisiken sowie der begrenzte Nutzungskorridor sind dokumentiert; dies ersetzt keine Rechtsberatung. |
| BRADLEY-004 | fertig | Primäre Metapher und erlaubtes Vokabular definieren; Vertrag: [Bradley Metaphern- und Sprachleitfaden](./bradley-brand-language-guide.md) | Der Sprachleitfaden legt Canvas und Faltflächen als einzige visuelle Begriffswelt fest und schließt widersprüchliche Metaphern aus. |
| BRADLEY-005 | fertig | Feste, persönliche und Workspace-bezogene Identitätsebenen verbindlich festlegen; Vertrag: [Bradley Identitätsebenen-Vertrag](./bradley-identity-layer-contract.md) | Prompt- und Copy-Hierarchie ist mit Priorität, Geltungsbereich, Konfliktregeln und Tests als implementierbarer Vertrag beschrieben. |
| BRADLEY-006 | fertig | Terminologie Bradley versus Canvas Host Agent abstimmen; Vertrag: [Bradley und Canvas Host Agent Terminologievertrag](./bradley-agent-terminology-contract.md) | Support- und Architekturdokumente unterscheiden Bradley, Host-Dienst, Control Plane und interne ID eindeutig. |

### Phase B — Visuelles System

| ID | Status | Aufgabe | Abnahmekriterium |
| --- | --- | --- | --- |
| BRADLEY-010 | fertig | Referenzrender und Nutzungsnachweis portabel ins Projekt übernehmen; Nachweis: [Bradley Asset Provenance](./assets/bradley/PROVENANCE.md) | Masterdatei, Importherkunft, Product-Owner-Autorisierung, Nutzungsgrenzen und SHA-256-Prüfsummen liegen an einem stabilen Projektpfad. |
| BRADLEY-011 | fertig | Transparentes Bradley-Character-Master erstellen; Nachweis: [Bradley Character Master QA](./assets/bradley/MASTER-QA.md) | Freigestellte hochauflösende Datei besitzt keine weißen Randartefakte. |
| BRADLEY-012 | fertig | Light- und Dark-Mode-Character-Varianten erstellen; Vertrag: [Bradley Character Theme Variants](./assets/bradley/THEME-VARIANTS.md) | Beide Varianten funktionieren auf realen Canvas-Flächen und erfüllen die Kontrastanforderungen. |
| BRADLEY-013 | fertig | Bradley-Glyph als SVG entwerfen; Nachweis: [Bradley Glyph Small-Size QA](./assets/bradley/GLYPH-QA.md) | SVG ist bei 16, 20, 24, 32 und 40 px eindeutig erkennbar. |
| BRADLEY-014 | fertig | Monochrome und High-Contrast-Varianten erstellen; Nachweis: [Bradley Glyph Monochrome and High-Contrast QA](./assets/bradley/GLYPH-CONTRAST-QA.md) | Glyph bleibt ohne Farbe und Textur unterscheidbar. |
| BRADLEY-015 | fertig | Kleine Zustandsvarianten definieren; Vertrag: [Bradley Small-State System](./assets/bradley/STATE-SYSTEM.md) | Idle, Arbeit, Warten und Abschluss sind unterscheidbar, ohne anatomische oder Comic-Mimik. |
| BRADLEY-016 | in Arbeit | Motion-Spezifikation inklusive Reduced Motion erstellen; erster Vertrag ist im Asset-README dokumentiert | Dauer, Easing, Bedeutung, Performance und bewegungsarme Alternative sind dokumentiert. |

### Phase C — Sprache und UX

| ID | Status | Aufgabe | Abnahmekriterium |
| --- | --- | --- | --- |
| BRADLEY-020 | offen | Vollständige Zustands-Copy-Matrix erstellen | Alle Runtime-, Tool-, Queue-, Delegations-, Automation-, Warte-, Erfolgs- und Fehlerzustände besitzen DE-/EN-Texte. |
| BRADLEY-021 | offen | Fehler- und Recovery-Muster definieren | Jede Fehlermeldung kann Ursache, Auswirkung und nächste Aktion sachlich anzeigen. |
| BRADLEY-022 | offen | Kontextmatrix für Hauptagent, Spezialagent, E-Mail-Agent und Automation erstellen | Für jede Oberfläche ist definiert, welcher Name und welches Icon erscheinen. |
| BRADLEY-023 | offen | Anti-Clippy- und Motion-Regeln in die UI-Spezifikation übernehmen | Review-Checkliste deckt Unterbrechungen, Idle-Animation, Reduced Motion und Barrierefreiheit ab. |
| BRADLEY-024 | offen | DE-/EN-Sprachleitfaden für Bradley erstellen | Ton, Anrede, Pronomen, Metaphern, Fehlersprache und verbotene Formulierungen sind dokumentiert. |

### Phase D — Runtime, Prompt und Migration

| ID | Status | Aufgabe | Abnahmekriterium |
| --- | --- | --- | --- |
| BRADLEY-030 | offen | Feste Bradley-Identität in der Prompt-Architektur verorten | Identität bleibt stabil und steht nicht im Konflikt mit Nutzeranweisung, SOUL.md oder Workspace Brand Voice. |
| BRADLEY-031 | offen | Onboarding auf feste Identität plus persönliche Zusammenarbeit umstellen | Neue Nutzer lernen Bradley kennen, können aber Kommunikationspräferenzen festlegen. |
| BRADLEY-032 | offen | Schutz vorhandener persönlicher `SOUL.md`-Inhalte konzipieren | Migration überschreibt keine bestehenden Präferenzen ohne dokumentierte Regel. |
| BRADLEY-033 | offen | Display-Name-Migration für bestehende Hauptagent-Datensätze entwickeln | Bestehende Standardnamen werden idempotent migriert; bewusste Anpassungen bleiben erhalten. |
| BRADLEY-034 | offen | UI-Fallbacks und Registry-Defaults inventarisieren und aktualisieren | Kein sichtbarer Standard-Fallback zeigt unbeabsichtigt „Canvas Agent“, wenn der Hauptagent Bradley ist. |
| BRADLEY-035 | offen | Onboarding-, Notification-, Automation- und E-Mail-Texte inventarisieren | Alle sichtbaren Hauptagent-Referenzen sind klassifiziert und entweder migriert oder bewusst beibehalten. |
| BRADLEY-036 | offen | Interne ID- und Pfadstabilität durch Regressionstests absichern | Tests belegen, dass `canvas-agent`, Sessions, Automationen, APIs und Speicherpfade unverändert funktionieren. |

### Phase E — UI-Pilot

| ID | Status | Aufgabe | Abnahmekriterium |
| --- | --- | --- | --- |
| BRADLEY-040 | offen | Bradley im Hauptagent-Selector und Chat-Header integrieren | Nur der Hauptagent erscheint als Bradley; Spezialagenten behalten Name und Icon. |
| BRADLEY-041 | offen | Bradley-Glyph als Hauptagent-Avatar integrieren | Glyph ist in allen unterstützten Größen und Themes scharf und zugänglich. |
| BRADLEY-042 | offen | Arbeitszustand beim Antwortstart integrieren | Status bleibt semantisch korrekt, screenreader-tauglich und bewegungsarm verfügbar. |
| BRADLEY-043 | offen | Einen Starter-/Empty-State mit Bradley umsetzen | Bradley unterstützt die Orientierung, ohne Inhalte oder Aktionen zu verdrängen. |
| BRADLEY-044 | offen | UI- und End-to-End-Prüfung durchführen | Nach ausdrücklicher Playwright-/Browser-Freigabe sind Desktop, Mobile, Light, Dark und Reduced Motion geprüft. |
| BRADLEY-045 | offen | Pilot anhand definierter Kriterien einschließlich mehrsprachiger Bradley-Namensstichprobe auswerten | Verständlichkeit, Namenswirkung, Agentenunterscheidung, Vertrauen und Störwirkung sind dokumentiert. |

### Phase F — Erweiterter Rollout und Marketing

| ID | Status | Aufgabe | Abnahmekriterium |
| --- | --- | --- | --- |
| BRADLEY-050 | offen | Geeignete weitere Empty States und Fehlerseiten auswählen | Jede Fläche hat einen konkreten Orientierungsnutzen; rein dekorative Einsätze werden vermieden. |
| BRADLEY-051 | offen | Automation- und Hintergrundkommunikation anpassen | Ausführender Agent, Status und menschliche Freigaben bleiben transparent. |
| BRADLEY-052 | offen | Benachrichtigungen und E-Mail-Texte aktualisieren | Texte benennen Bradley nur, wenn der Hauptagent tatsächlich die Quelle ist. |
| BRADLEY-053 | offen | Produktdokumentation aktualisieren | Hauptagent, Spezialagenten und Host-Agent sind eindeutig erklärt. |
| BRADLEY-054 | offen | Website-Copy und Launch-Story überarbeiten | Aussagen zu Self-Hosting, Cloud-Modellen, Daten und Automationen sind korrekt und überprüfbar. |
| BRADLEY-055 | offen | Marketing-Asset-Set produzieren | Freigegebene Formate, Hintergründe, Alt-Texte und Nutzungsregeln liegen vor. |

## 14. Erfolgskriterien

Der Pilot gilt als erfolgreich, wenn:

- Nutzer den Hauptagenten spontan als Bradley erkennen;
- Nutzer Bradley klar von eigenen Agenten, dem E-Mail-Agenten und Automationen
  unterscheiden können;
- Status- und Fehlermeldungen mindestens genauso verständlich bleiben wie vor
  dem Branding;
- Bradley als warm und professionell, nicht als kindlich oder aufdringlich
  wahrgenommen wird;
- die kleine Darstellung bei 16 bis 40 Pixeln zuverlässig funktioniert;
- Dark Mode, High Contrast, Screenreader und Reduced Motion berücksichtigt sind;
- keine bestehenden Agent-IDs, Sessions, Automationen oder persönlichen
  Prompt-Dateien beschädigt werden;
- Marketingaussagen die tatsächliche Daten- und Providerarchitektur korrekt
  wiedergeben.

## 15. Empfohlene Umsetzungsreihenfolge

1. BRADLEY-001 bis BRADLEY-006 abschließen.
2. Erst danach das visuelle System BRADLEY-010 bis BRADLEY-016 finalisieren.
3. Copy- und Kontextmatrix BRADLEY-020 bis BRADLEY-024 festlegen.
4. Prompt-, Onboarding- und Migrationsvertrag BRADLEY-030 bis BRADLEY-036 umsetzen und
   testen.
5. Den begrenzten UI-Pilot BRADLEY-040 bis BRADLEY-045 integrieren und auswerten.
6. Den erweiterten Rollout BRADLEY-050 bis BRADLEY-055 erst nach erfolgreichem Pilot
   beginnen.

Jede Phase wird vollständig abgeschlossen, geprüft und sauber committed, bevor
die nächste wichtige Phase begonnen wird.
