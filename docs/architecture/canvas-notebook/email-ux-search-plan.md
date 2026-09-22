# Plan: fokussiertes E-Mail-UI und verlässliche Suche

Stand: 22.09.2026. Umsetzung abgeschlossen; die ursprünglichen Befunde und Anforderungen unten dokumentieren die Ausgangslage.

## Umsetzung und Abnahme

- Gemeinsamer Suchparser und Provider-Adapter umgesetzt, einschließlich AND/OR, Phrasen, Klammern und Feldsuche. API und Agent verwenden dieselbe Syntax; ungültige Eingaben liefern HTTP 400.
- Suchbereich, Optionen, Hilfe, Zurücksetzen, Trefferhervorhebung und wiederholtes Absenden umgesetzt. Langsame Antworten überschreiben keine neuere Suche; Treffer aus anderen Ordnern öffnen korrekt.
- Fokusansicht schließt optionale Seitenbereiche und stellt sie wieder her. Manuelles Öffnen beendet den Fokusmodus; Ordnerpräferenz wird gespeichert.
- Kompakter Postausgang-Einstieg und aufklappbare Review-Details. Absender, Betreff, Fehlerstatus und Hauptaktionen bleiben sichtbar; mobile Beschriftungen brechen um.
- 15 Playwright-Szenarien bestanden, einschließlich deutscher 320-Pixel-Ansicht, 1024 × 600, Suchoptionen, veralteter Antworten, Fokuswiederherstellung und bestehender Versand-/Ablehnungsabläufe. E-Mail-Provider und Versand wurden im Browser simuliert.
- Vier neue Backend-Testgruppen bestanden: Suchgrammatik, OAuth-Provider, IMAP sowie Managed-Vertrag (`npm run test:email:search`). Bestehende Review-, IMAP-, Cache-, Suchkontext- und Lesefluss-Regressionstests bestanden; TypeScript und gezieltes ESLint bestanden.
- Abschließender Produktionsbuild erfolgreich; die letzte Benachrichtigungsübersetzung ist im Build-Artefakt enthalten. Deutsche 320-/1024-Pixel-Prüfungen melden keine Browserfehler.

### Bewusste Grenzen

- Live-Suche mit echten Gmail-/Microsoft-/IMAP-Konten wurde nicht ausgeführt; die Provider-Verträge sind mit kontrollierten Transporten getestet. Kein echter E-Mail-Versand und kein Containerbuild.
- Provider-Wort-/Phrasenmatching kann abweichen. Microsoft-Suchgrenze: 1.000 Ergebnisse. OAuth-Kandidatenscans und IMAP-Gesamtsuche sind begrenzt; Teilmengen erhalten einen sichtbaren Hinweis statt einer vorgetäuschten Gesamtzahl. IMAP: höchstens 100 Ordner, 1.000 Kandidaten pro Ordner und 2.000 insgesamt bei Gesamtsuche.
- Ältere Managed-Server unterstützen den neuen Vertrag noch nicht: Operatoren, Felder, Gesamtsuche, Filter und weitere Seiten verlangen `searchSyntaxVersion: 1` in der Antwort. Bis zum Control-Plane-Update zeigt die App eine konkrete Fehlermeldung; einfache Legacy-Suchen zeigen ihre unbestätigte Abdeckung an.
- Aktive Suchen umgehen den bisherigen Listen-Cache, weil dieser Fortsetzungs- und Einschränkungsmetadaten nicht speichert. Der Cache für gewöhnliches lokales Postfach-Browsing bleibt erhalten.

## Verifizierter Status

- Playwright-Prüfung am aktuellen Worktree mit authentifizierter Sitzung und simulierten E-Mail-Daten bei 1280 × 720 und 390 × 640. Keine echten E-Mails versendet; keine Live-Provider-Suche getestet.
- Die Aktionsleiste im globalen Review bleibt beim Scrollen sichtbar. Mobil beginnt der Texteditor im Ausgangszustand erst bei etwa y=564, während die Aktionsleiste den unteren Bereich belegt. Permanente Metadaten, CC/BCC, Erklärung und Toolbar verdrängen den eigentlichen Inhalt.
- Absender und Fehlerhinweise liegen im scrollenden Bereich. Die Review-Liste ist am Desktop nicht einklappbar; mobil ist der Zurück-zur-Liste-Schalter ebenfalls im scrollenden Bereich.
- Die Ordnerleiste des Postfachs ist bereits ein-/ausblendbar, standardmäßig geschlossen und auf kleinen Flächen durch ein Menü ersetzt. Ihr Zustand wird nicht gespeichert. Die Listenbreite wird gespeichert.
- Die Chat-Seitenleiste ist bereits umschaltbar und speichert ihren Zustand. Im geprüften 1280-Pixel-Fenster reduziert sie die Postfachbreite so stark, dass der kompakte Modus ohne gleichzeitigen Lesebereich aktiv ist.
- Der Review-Einstieg nimmt auch bei leerem Stapel zwei Zeilenblöcke in Anspruch.
- Gleiche Query erneut per Enter: reproduziert kein neuer Listenabruf. `handleSearch` setzt nur dieselben State-Werte; es fehlt ein expliziter Refresh für diesen Fall.
- IMAP übersetzt jede Query zu `{ text: query }`: AND/OR werden nicht geparst. Gmail erhält die rohe Query, Microsoft einen maskierten `$search`-Ausdruck. Es fehlt ein gemeinsamer Suchvertrag.
- `email_search_messages` beschreibt die Query-Syntax nicht. Agent und UI können deshalb unterschiedliche Erwartungen an denselben Text haben.
- Managed-Listenabrufe übertragen aktuell nur accountId, query, limit; Ordner/Filter/Paginierung müssen im Vertrag mit dem Control Plane geprüft werden.

## 1. Sichtbaren Inhalt priorisieren

- Postfach: kompakte Zeile aus Konto, Suche und Hauptaktion; leerer Review-Stapel nur als dezenter Postausgang-Einstieg. Offene Vorschläge und Fehler als Zähler, Vorschau erst nach Öffnen.
- Vorhandene Ordner- und Chat-Schalter verwenden und verständlicher beschriften. Ordnerzustand speichern. E-Mail-Fokusansicht schließt optionale Seitenbereiche und lässt sich leicht verlassen; explizite Nutzerpräferenzen nicht überschreiben.
- Spalten anhand der tatsächlich verfügbaren Inhaltsbreite und einer Mindestbreite des Lesebereichs wählen. Bei zu wenig Platz Ordner als Menü bzw. Chat als Overlay; nicht alle Spalten zusammenquetschen.
- Review: kompakter dauerhaft sichtbarer Kontext mit Absenderpostfach, Empfängerzusammenfassung, Betreff und Position im Stapel; Liste am Desktop einklappbar. Mobile Listennavigation dauerhaft erreichbar.
- Empfängerdetails aufklappbar. Vorhandene CC/BCC als erkennbare Anzahl/Chips anzeigen, leere Felder erst über „CC/BCC hinzufügen“. Anhänge kompakt mit Anzahl, Details auf Wunsch. Formatierung bleibt erhalten, erweiterte Editorwerkzeuge erst bei Bedarf.
- Senden und Ablehnen bleiben sichtbar; Speichern/Später visuell nachgeordnet. Kurzer Fehlerstatus bleibt im sichtbaren Kontext, vollständige Diagnose und Einstellungen aufklappbar. Sperren niemals allein in versteckten Details erklären.
- Mobile Tastatur, Safe Areas, 200 % Zoom, lange Adressen und lange Fehlermeldungen berücksichtigen. Nur der Inhalt scrollt; Header/Footer dürfen ihn nicht vollständig verdrängen.

## 2. Gemeinsamen Suchvertrag festlegen

- Standard: Suche im ausgewählten Postfach über Absender/Empfänger (Name und Adresse), Betreff und Nachrichtentext. To/CC sowie verfügbare BCC einbeziehen. Keine Suche ausschließlich in geladenen Listen oder Vorschau-Snippets.
- Suchbereich sichtbar auswählbar: aktueller Ordner oder gesamtes ausgewähltes Postfach. Standard aktueller Ordner; leichte Erweiterung auf das gesamte Postfach bei fehlenden Treffern. Kein stiller Wechsel über Konten hinweg.
- Mehrere freie Begriffe bedeuten AND; jeder Begriff darf in einem anderen Feld derselben Nachricht vorkommen. OR bedeutet mindestens ein Ausdruck. AND bindet stärker als OR; Klammern gruppieren. Anführungszeichen bilden Phrasen. Operatoren außerhalb von Anführungszeichen in Großbuchstaben.
- Begrenzte erste Syntax: freie Begriffe, AND, OR, Klammern, Phrasen, `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `body:`. Unbekannte Feldoperatoren, unvollständige Ausdrücke und zu komplexe Queries liefern verständliche Fehler statt stiller Fehlinterpretation.
- Beispiele: `rechnung september`, `rechnung OR angebot`, `from:anna@example.de AND subject:rechnung`, `subject:"Projekt Alpha"`, `(rechnung OR angebot) AND september`.
- Groß-/Kleinschreibung, Unicode/Umlaute, Phrasen und Wort-/Teilwortverhalten als Testvertrag definieren. Anbietergrenzen offen anzeigen, keine identischen linguistischen Treffer versprechen, wenn der Provider sie nicht unterstützt.

## 3. Suchausführung vereinheitlichen

- Gemeinsamer Parser und validierter Suchbaum vor den Provider-Adaptern, wiederverwendet durch Listen-API, Agent-Tool und Managed-Pfad. Keine beliebigen ungeprüften Provider-Ausdrücke durchreichen.
- Adapter für IMAP, Gmail und Microsoft übersetzen dieselbe Bedeutung, einschließlich expliziter Empfängerfelder. Microsoft durchsucht ohne Feldangabe standardmäßig nur from/subject/body; Empfänger müssen explizit ergänzt werden.
- Provider-Paginierung und Suchgrenzen korrekt behandeln. Insbesondere Gmail-Seitentokens, Microsoft-Suchparameter und Managed-Cursor prüfen; nie nur die erste Trefferseite nachfiltern und als vollständiges Ergebnis ausgeben.
- Cache-Schlüssel aus normalisierter Query samt Syntaxversion, Konto, Ordner, Filtern und Seite bilden. Gleiche Eingabe erneut absenden aktualisiert explizit; schnelle Änderungen dürfen keine alten Treffer zurückschreiben.
- Agenten behalten serverseitige Lesepolicy und Postfachberechtigungen. UI und Tool teilen Syntax und Suchbereich, nicht automatisch identische Zugriffsrechte. Teilmengen wegen Policy oder Anbietergrenzen kennzeichnen.

## 4. Suche verständlich erklären

- Ein Suchfeld für den Alltag; „Suchoptionen“ öffnet Von/An/Betreff/Text und „alle/einer der Begriffe“. Diese Felder erzeugen denselben Suchbaum wie die Texteingabe.
- Kleine Hilfe mit klickbaren Beispielen und Erklärung von AND/OR/Phrasen. Deutsche UI-Beschriftung, dokumentierte Operatoren unverändert.
- Aktive Suche samt Bereich anzeigen; Eingabeentwurf und angewendete Query unterscheidbar halten. Löschen und Suche zurücksetzen leicht erreichbar.
- Treffer zeigen Absender bzw. Empfänger, Betreff, Datum und passenden Textausschnitt; Hervorhebung sicher als Text rendern. Leere Treffer, ungültige Query, Ladefehler und unvollständige Ergebnisse klar unterscheiden.
- Agent-Toolbeschreibung erhält identische Beispiele, Grenzen und Fehlerhinweise. Tool-Ergebnis nennt angewendeten Suchbereich und Fortsetzungsmöglichkeit; Deep Link reproduziert dieselbe Suche.

## 5. Abnahme

- Zuerst Suchvertrag und Regressionsfälle festlegen, dann Parser/Adapter, dann Such-UI, anschließend Fokus-/Review-Layout. Jeden Schritt prüfen und separat committen.
- Deterministische Nachrichten: Treffer ausschließlich in To, CC, Betreff oder tief im Body; verteilte AND-Begriffe; OR; Phrasen/Klammern; Umlaute; ungültige Syntax; Treffer jenseits der ersten Seite; Policy-gefilterte Treffer.
- Provider-Vertragstests, Cache-/Paging-Tests sowie Tool/UI-Parität. Live-Provider-Test erst mit geeigneten Testkonten, ohne Versand.
- Playwright: 1440 × 900, 1280 × 720, 1024 × 600, 390 × 640 und 320-Pixel-Breite, Chat offen/geschlossen, Ordner offen/geschlossen, lange Nachricht, Fehlerzustand und Zoom. Geometrisch prüfen: primäre Aktionen innerhalb des Viewports und nicht überlagert; lesbarer Inhaltsbereich bereits beim Öffnen.
- Wiederholtes Enter, Query-Wechsel während laufender Suche, Zurücksetzen, Ordnerwechsel, Paging, Deep Links und Tastaturbedienung testen. Abschließend TypeScript, relevante Regressionstests und Produktionsbuild.

## Quellen

- Code: EmailClient, EmailMailboxNavigation, EmailWorkspaceLayout, EmailReviewHost, EmailReviewCenter, EmailShell, email/service, local-service, imap-service, pi/workspace-email-tools.
- Microsoft: https://learn.microsoft.com/en-us/graph/search-query-parameter
- Gmail: https://developers.google.com/workspace/gmail/api/guides/filtering
