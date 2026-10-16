# Erweiterungssuche und Inline-Auswahl: Zuverlässigkeitsplan

Stand: 16.10.2026. **Plan, noch nicht umgesetzt.** Geprüfter Produktstand: `25dd54d59` im Notebook-Worktree `1cf2`.

Auftrag: Die gemeinsame Suche auf der Pluginseite und im Chat muss schnell und zuverlässig bedienbar sein. Ein ausdrücklich gewählter verwendbarer Treffer soll ohne unnötige Bestätigung als Inline-Referenz im Text landen. Echte Verbindungsentscheidungen bleiben explizit. Zunächst wird dieser Plan abgestimmt; keine Produktcodeänderung ist erfolgt.

## 1. Bestätigte Befunde und Grenzen

- Der Nutzerscreenshot zu `canvas-design` zeigt einen Treffer mit `AGENT_EXTENSION_PARENT_SELECTION_REQUIRED`: Der Suchpfad hat keine direkt verwendbare Auswahl geliefert und verlangt die Auswahl über das veröffentlichte Elternpaket. Trotzdem öffnet der normale Trefferklick einen allgemeinen Einfügedialog. Der deaktivierte Button ist hier Folge des widersprüchlichen Auswahlvertrags, keine fehlende weitere Nutzerbestätigung.
- Andere gezeigte Treffer melden fehlendes aktuelles Paket-Use. Der Name allein beweist weder Nutzbarkeit noch dieselbe Herkunft; gleichnamige Einträge dürfen nicht pauschal zusammengeführt werden.
- Jede Extension-/Recent-Auswahl öffnet derzeit `ChatExtensionReferenceDialog`, auch Core-Skills ohne Verbindungswahl. Ein einfacher, direkt verwendbarer Core-Skill hat dagegen serverseitig eine echte `core_skill`-Selection mit `eligibility=select`; die sichtbare Gegenprobe mit `skill-creator` im Home-Composer zeigt einen aktiven Einfügen-Button. Ein global identischer Fehler für sämtliche Arten ist damit nicht belegt; die im Screenshot gezeigten Parent-/Use-Fälle bleiben bestätigt.
- Ein neuer Chat ist serverseitig über `draft_turn` unterstützt. Eine fehlende gespeicherte Sitzung ist keine belegte Ursache und darf für das Einfügen nicht erst erzeugt werden.
- Drei parallele authentifizierte Metadatenabfragen auf dem laufenden kompilierten lokalen Stand ergaben: Core-Skillsuche 16.765 ms, installierte Paketsuche 20.379 ms, gemeinsame Suche 21.792 ms. Beide letztgenannten Antworten meldeten einen Store-Timeout. Das sind drei Einzelmessungen unter gleichzeitiger Last, keine isolierten Laufzeiten oder p95-Werte. Privater Bericht: `/tmp/canvas-extension-search-baseline.json`.
- Die gemeinsame Suche wartet auf lokale Pakete, Store, Composio und MCP. Auch eine Installiert-Suche lädt häufig den Store. Store-Suche traversiert bis zu 20 Seiten mit wiederholten vollständigen Paket-/Bestandsprüfungen. Abgebrochene Clientrequests beenden diese Arbeit nicht durchgängig.
- Ein Chat-Suchlauf lädt den installierten Ressourcenbestand mehrfach; darunter liegen wiederholte Autoritäts-, Parent-/Child-, Grant- und Labelabfragen mit eigenen DB-Leases. Die Auswahlprojektion lädt nach der bereits frischen Abschlussprüfung nochmals den gesamten Bestand.
- Installierte Treffer bekommen auch ohne deklarierte Bildquelle einen Icon-Endpunkt. Der normale erfolgreiche Bildpfad löst denselben vollständigen Paket-/Katalogpfad mehrfach auf, bei identischen requested/source-Objekten teilweise unmittelbar doppelt. Die genaue Zeitverteilung auf SQL, Dateien, Icons und externe Quellen ist noch nicht gemessen.
- Der Avatar zeigt Initialen bei fehlender URL oder nach einem Bildfehler; während einer hängenden Bildanfrage bleibt die Fläche leer. Das erklärt einen Teil der leeren Felder in den Screenshots.
- Die bisherigen funktionalen Creator-Abnahmen belegen keine ausreichende Suchlatenz unter schneller Texteingabe und gleichzeitigen Iconrequests. Diese Lücke bekommt eigene Abnahmekriterien.

## 2. Zielverhalten und Progressive Disclosure

Eine Suche umfasst weiterhin Plugins, Skills, Composio und MCP. Typ-, Bestands- und Herkunftsfilter verfeinern dieselben Ergebnisse. Es entstehen keine getrennten Suchseiten oder unabhängigen Katalogimplementierungen.

### Öffnen und Schreiben

1. Das Popup öffnet unmittelbar. Ohne Suchtext stehen zuletzt verwendete, aktuell verwendbare Referenzen vorne.
2. Lokale beziehungsweise bereits verbundene Treffer erscheinen zuerst; externe Kataloge ergänzen dieselbe Liste unabhängig davon.
3. Ein kleiner Quellenstatus zeigt beispielsweise „Weitere Integrationen werden geladen“. Ein Store-Ausfall darf bereits vorhandene Treffer und Tastaturbedienung nicht blockieren.
4. Nur die aktuelle Anfrage darf Ergebnisse ergänzen. Bei weiterem Tippen werden alte Arbeit und Antworten verworfen. Die zuletzt korrekt dargestellte Liste kann für dieselbe Abfrage sichtbar bleiben; eine Liste für einen anderen Suchtext darf nicht irreführend auswählbar bleiben.
5. Nachgeladene Treffer verändern den per Tastatur fokussierten Eintrag nicht. Auswahl wird über die kanonische ID erhalten, nicht über einen unveränderten Listenindex.
6. „Keine Treffer“ erscheint erst, wenn die dafür relevanten Quellen fertig sind. Ladezustand, Teilfehler, leeres Ergebnis und Wiederholung sind getrennte Zustände.

### Auswählen und Einfügen

| Zustand | Verhalten |
| --- | --- |
| Verwendbarer Skill/Plugin ohne offene Pflichtwahl | Klick, Enter oder Tab startet eine frische kurze Auswahlprüfung und fügt danach genau eine Inline-Referenz ein. Kein zusätzlicher Bestätigungsdialog. |
| Bereits vollständig gebundene Referenz mit gültigen Belegen | Dieselbe direkte Strecke; bestehende Komponenten, Toolgrenzen und Verbindungen bleiben erhalten. |
| Noch kein genauer gültiger Account gebunden oder offene Pflichtverbindung | Nur die notwendige Verbindungswahl öffnen. Mehrere verfügbare Alternativen allein erzwingen bei bereits gültiger genauer Bindung keinen neuen Dialog. Keine automatische Auswahl des ersten Accounts oder MCPs. Ein abschließender tatsächlicher Auswahlvorgang führt zum Einfügen. |
| Optionale Verbindung/zusätzliche Bestandteile | Standardmäßig keine zusätzliche Pflichtwahl. „Anpassen“ öffnet diese Details ausdrücklich. |
| Abgelaufener persönlicher Composio-Beleg | Dasselbe genaue Konto erneut bestätigen; kein stiller Ersatzaccount. |
| Installierbar oder Einrichtung erforderlich | Klar beschriftete Aktion wie „Verbinden“, „Installieren“ oder „Eltern-Plugin öffnen“. Kein allgemeiner Dialog mit wirkungslosem Einfügen-Button. Nachrichtentext bleibt erhalten. |
| Fehlendes Use-Recht oder unzulässiger Agentkontext | Grund an der Zeile; keine Einfügeaktion. Nutzbare Treffer zuerst, weitere Treffer bei Bedarf aufklappbar. Keine Freigabe oder Aktivierung nebenbei. |

Während der Prüfung zeigt die ausgewählte Zeile einen Status und bleibt mit Escape abbrechbar. Fehler werden dort verständlich angezeigt, mit Wiederholung oder konkretem Einrichtungsschritt. Der Originaltext bleibt bis zur erfolgreichen Einfügung unverändert.

Der eingefügte Verweis bleibt ein Bestandteil des Nachrichtentexts: Logo/Initialen und Name, weiterhin durch normales Löschen entfernbar. Keine zusätzliche Referenzleiste oberhalb des Composers. Die Hintergrundkontextübergabe bleibt an den strukturierten Verweis gebunden.

## 3. Umsetzung in abgeschlossenen Schritten

### P1 — Auswahlvertrag und Diagnostik klären

- Für jeden Treffer einen eindeutigen Vertrag liefern: direkte kanonische Selection, notwendige Verbindungswahl, Einrichtung oder nicht verfügbar. `action=select` ohne verwendbare Selection ist im Chat kein gültiger Endzustand.
- Plugin-Kinder aus dem tatsächlich zugehörigen Core-Elternplugin oder der genauen veröffentlichten Elternrevision referenzieren. Eigenen Skillpfad und Parent-Pin erhalten. Bei fehlender gültiger Quelle eine passende Einrichtung/Erklärung liefern, keine unabhängige Ersatzidentität erfinden.
- Gleichnamige Einträge über Paket, Herkunft, Organisation und Version unterscheidbar machen; nur exakt dieselbe kanonische Identität deduplizieren.
- Sichere Messspans und Arbeitszähler für Kontext, lokalen Bestand, externe Quellen, frische Abschlussprüfung, Auswahlprojektion und Icons ergänzen. Keine Tokens, Kontoinhalte oder vollständigen Such-/Nachrichtentexte protokollieren.
- Im echten HTTP-Pfad ein Gesamtzeitbudget mit dem Request-Abbruchsignal kombinieren. Das bisherige `request.signal ?? timeout` setzt bei vorhandenem Requestsignal kein eigenes Zeitbudget.

**Abnahme:** `canvas-design`, Core-Skill/-Plugin, veröffentlichter Standalone-Skill, Paketkind, gesperrtes Paket und verbundener MCP liefern einen zutreffenden ausführbaren oder erklärten Zustand. Neuer Chat benötigt weder Sessionanlage noch Nachricht.

### P2 — Gemeinsamen Lese- und Suchpfad entlasten

- Lokalen Bestand aus einem auf Actor/Workspace und Prüfphase begrenzten Lesekontext erzeugen. Authority, Ressourcen, Grants und Labels gebündelt laden; Parent-/Child-Regeln bleiben identisch. Kein globaler Cache für Berechtigungsentscheidungen.
- Vor externem I/O und danach zwei getrennte Autoritätsphasen verwenden. Den frischen Abschlussbestand gemeinsam für Revalidierung und Ergebnisprojektion nutzen; keinen dritten vollständigen Bestandsdurchlauf starten.
- Suche liest Metadaten; vollständiges Kopieren, Validieren und mehrfaches Hashen aller Paketdateien gehört nicht in jede Suchanfrage. Die unabhängige genaue Prüfung bei Auswahl, Preview und Send bleibt erhalten.
- Installierte Suche darf ohne ausdrücklich benötigten Store-/Herkunftsschritt auskommen. Exakte Storeauswahl, Cursor und Aktualisierungs-/Installationswege behalten ihre Semantik.
- Öffentliche Registrymetadaten kurz und begrenzt mit Singleflight cachen, beispielsweise 30–60 Sekunden. Cache nach Quelle und Protokoll-/Netzwerkpolicy trennen; Installations-/Reviewentscheidungen weiter frisch prüfen. Keine Fehler oder vertraulichen Accountdaten als erfolgreiche Metadaten cachen.
- Pro Storequelle eine begrenzte Seite lesen und vorhandene Continuations verwenden; Plugin-/Skill-Registry unabhängig laden. Keine Schleife über bis zu 20 vollständige Store-/Bestandsabnahmen für einen Tastendruck.
- Abbruch und Budget bis zu Fetches und teuren Schleifen weiterreichen. Begrenzte Parallelität statt unbeschränkter DB-Poolkonkurrenz.

**Abnahme:** Arbeitszähler für 1/10/50 Ressourcen und drei gleichzeitige Anfragen. Authorityabfragen wachsen nicht pro Ressource; keine wiederholten vollständigen Katalogladungen pro Treffer. Rechteentzug während externem I/O bleibt wirksam.

### P3 — Lokale Treffer sofort, externe Quellen ergänzend

- Gemeinsame Suchdienste um explizite begrenzte lokale und externe Ladephasen ergänzen. Web, Chat, Agentauswahl und unterstützte native Adapter benutzen denselben Vertrag und dieselben IDs; keine zweite Suchregistry.
- Ein Suchvorgang besitzt Querygeneration, Actor-/Authscope, Workspace, Agentziel und Abbruchsteuerung. Quellen dürfen nur in den noch aktuellen Vorgang einfließen.
- MRU, lokale Treffer und Quellenseiten unabhängig anzeigen und kanonisch zusammenführen. Persönliche Composio-Konten erst nach ausdrücklicher Profilauswahl laden.
- Passenden kurzen Debounce beibehalten; gleichzeitige identische Metadatenanfragen zusammenfassen. Mehrfachanfragen nicht lediglich zeitlich verzögern, während jede alte Anfrage weiterläuft.
- Ergebnisreihenfolge: anfangs zuletzt verwendet; bei Texteingabe exakte Namen und Namensanfänge vor breiten Beschreibungstreffern. Während Tastaturnavigation Fokus-ID stabil halten.
- Quellenstatus und partielle Fehler im Popup zeigen; Retry nur für die betroffene Quelle. Bereits benutzbare Treffer bleiben aktiv.

**Abnahme:** Verzögerter/ausgefallener Store oder Composio blockiert lokale Skills/MCPs nicht. Schnelles `/c` → `/ca` → `/can` zeigt ausschließlich passende aktuelle Ergebnisse; Pfeiltastenfokus springt beim Nachladen nicht auf ein anderes Objekt.

### P4 — Direkte Inline-Auswahl und notwendige Konfiguration

- Den Bestätigungsdialog aus dem normalen direkten Auswahlpfad entfernen. Gemeinsamen kurzen Auswahl-/Previewpfad für Maus, Enter und Tab verwenden.
- Echte Pflichtentscheidungen, Änderungen an Bestandteilen und Konto-Erneuerung gezielt über Progressive Disclosure öffnen. Keine blinde automatische Verbindungswahl.
- Asynchrone Einfügung mit aktuellem Authscope, Target, Workspace, Agent, Originalbody und Auswahlvorgang absichern. Ein alter React-Callback darf nicht nach einer neuen Auswahl oder einem Kontextwechsel einfügen.
- Den vorhandenen gemeinsamen Commitpfad für Bodygrenzen, atomare Editor-Einfügung und flüchtige Accountbelege nutzen. Recents dürfen Supporting-Selections und Verbindungszuordnungen nicht verlieren. Beim regulären Wechsel von Draft zu gespeicherter Session bleiben bestehende Referenzen und gültige flüchtige Belege im selben Auth-/Agent-/Workspacebereich erhalten; verspätete Auswahlantworten für das alte Ziel dürfen nicht nachträglich einfügen.
- Kein dauerhaft inaktiver Button ohne Ladeanzeige, Begründung und ausführbare Folgemaßnahme. `setup`/`unavailable` bekommt eine passende Aktion, keinen simulierten Einfügedialog.
- Home-Composer, neuer Notebookchat und bestehender Chat erhalten dieselben Zustände und Regeln.

**Abnahme:** Verwendbarer Skill/Core-Plugin per Pfeiltasten plus Enter genau einmal eingefügt; kein zweiter Klick, kein Send, keine Sessionanlage. Escape, Texteingabe, Draft→Session, Workspace-/Agent-/Authwechsel, abgelaufene Belege und verspätete Antworten erzeugen keine falsche Referenz. Pflichtverbindungen bleiben wirksam.

### P5 — Icons ohne Lastlawine und ohne Leerfläche

- Initialen sofort anzeigen und erst nach erfolgreichem Bildladen durch das Logo ersetzen. Fehlende, langsame und defekte Bilder lassen Text und Auswahl bedienbar.
- Ohne tatsächliche Bilddeklaration keine spekulative Paket-Icon-Anfrage erzeugen.
- Im Paketbilddienst identische Quellenprüfungen je Vor-/Nachphase deduplizieren. Gehaltene genaue Source-/Storage-/Parent-/Revisionsstamps und Bildinventare verwenden, statt denselben gesamten Katalog wiederholt aufzulösen oder für ein Bild das ganze Paket zu kopieren.
- Bildbytes anhand der genauen Quelle begrenzt cachen; aktuelle Leserechte davor frisch prüfen. Bild-/SVG-/Pfad- und Größenprüfung bleiben erhalten. Keine öffentlich cachebaren privaten Bildantworten.
- Composio verwendet weiterhin mitgelieferte API-Logos; eigene MCPs weiterhin den vorhandenen geschützten Domainlogodienst. Fehlende Bildquelle fällt auf Namensinitialen zurück.

**Abnahme:** 30 Treffer erzeugen keine 30 vollständigen Katalogauflösungen oder Requests für sicher bildlose Skills. Initialen sind sofort sichtbar; Webbilder, SVG, defekte Logos und schmale/helle/dunkle Darstellung werden geprüft.

### P6 — Gesamtabnahme und aktualisiertes Dev-Setup

- Fokussierte echte API-/SQL-Regressionen für Use/Read, zwei Nutzer und Organisationen, Parent-/Child-Herkunft, feste Agentgrenzen und Widerruf während laufender Abfragen.
- Komponenten-/Lifecycleprüfungen für Ladezustände, Tastatur, direkte Auswahl, erforderliche Konfiguration, Body-/Auth-/Workspacewechsel und fehlgeschlagene Preview.
- Browserabnahme auf Pluginseite, Home, neuem und bestehendem Chat: schnelle Texteingabe, MRU, alle Typfilter, Core/Standalone/Paketkind, MCP/Composio und Ausfälle. Maus und Tastatur, Desktop und schmale Darstellung.
- Produktbuild und passende Client-/Vertragsprüfungen bestehen lassen; anschließend aktuellen Stand im vorhandenen lokalen Testsetup bereitstellen. Kein neuer Container, öffentliches Deployment, Push oder Merge aus diesem Plan abgeleitet.
- Vorher-/Nachher-Werte mit identischen Daten und Messbedingungen dokumentieren; kalte/warme Anfragen, Icons an/aus und drei parallele Suchen getrennt ausweisen. Keine Erfolgsbehauptung nur aus einem kleinen gemockten Katalog.

## 4. Vorgeschlagene Zielwerte

Diese Werte sind Abnahmeziele, noch keine erreichten Messergebnisse:

- Popupreaktion und lokaler Lade-/MRU-Zustand innerhalb von 100 ms sichtbar.
- Erste lokale Treffer: warm p95 höchstens 300 ms, kalt p95 höchstens 1 s im definierten lokalen Testbestand.
- Einfache verwendbare Referenz: nach Auswahl warm p95 höchstens 500 ms bis zur Einfügung, ohne zweite Bestätigung.
- Langsame externe Quellen ändern diese lokalen Budgets nicht. Sie erhalten eigene begrenzte Budgets, sichtbaren Status und gezielte Wiederholung.
- Kein widersprüchliches „Loading“ plus endgültiges „Keine Treffer“; kein dauerhaft deaktivierter Einfügen-Button ohne Erklärung und Handlungsmöglichkeit.
- Ein Auswahlvorgang erzeugt höchstens eine Inline-Referenz; Abbruch und veraltete Antworten erzeugen keine.
- Keine Autoritätsabfragen pro Icon über den vollständigen Katalog und kein Abfragewachstum durch wiederholte ungebremste Suchläufe.

Falls Messung und Bestandsgröße einen Zielwert nicht tragen, wird vor Abschluss der konkrete Engpass ausgewiesen; keine stillschweigende Herabsetzung oder Umdeutung als bestanden.

## 5. Hauptbetroffene Dateien und Grenzen

- Suche/Quellen: `plugin-extension-search.ts`, `store-registry-reader.ts`, `store-actions.ts`, `extension-options-search.ts`, `extension-options-inventory.ts`.
- Ressourcenleser: `capabilities/resources/actions.ts`, `store.ts`, `labels.ts`, `capabilities/catalog.ts`.
- Inline-UI: `useComposerReferences.ts`, `ChatExtensionReferenceDialog.tsx`, `ComposerReferencePicker.tsx`, `ChatComposer.tsx`, `PromptHero.tsx`.
- Bilder: `PluginExtensionAvatar.tsx`, `plugin-workspace-catalog.ts`, `presentation-actions.ts`, `extension-package-icons.ts`.

Vor Symboländerungen sind aktuelle GitNexus-Impactprüfungen und die konkreten direkten Callers erforderlich. Der derzeitige Diagnoseindex ist gegenüber HEAD veraltet; bisherige Sourcebefunde wurden deshalb direkt gegengeprüft. Gemeinsame ACL-/Bilddienste werden in getrennten, prüfbaren Schritten geändert. Keine pauschale Lockerung von Rechten, Aktivierung, Agentgrenzen, Paketpins, Kontobelegen oder Netzwerkpolicy.

Anschluss: [Gemeinsame Chatreferenzen](chat-extension-reference-plan.md), [Inline-Verweise](chat-inline-reference-plan.md), [Pluginseite und Integrationskatalog](plugin-page-integration-catalog-plan.md), [Creator-Abnahme](creator-authoring-implementation.md).
