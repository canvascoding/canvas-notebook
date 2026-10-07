# E-Mail-Klassifizierung: Qualität, Betrieb und Recovery

Stand: 2026-10-07. Implementierter Vertrag unter `app/lib/email/classification/`; ursprüngliche Anforderungen im [Harness-Plan](email-classification-harness-plan.md), Prüfnachweise im [Umsetzungsnachweis](email-classification-implementation.md). Nutzer-/Adminbedienung: [Fokus](../../product/de/email/focus.mdx), [Vorbereitung administrieren](../../product/de/admin/email-classification.mdx).

## Aktivierung und Datenbereiche

Die Instanzkonfiguration ist standardmäßig deaktiviert. Ein Instanzadministrator aktiviert sie zentral für persönliche und zugewiesene gemeinsame Postfächer. Eine persönliche Fokus/Klassisch-Präferenz steuert die Ansicht. Sie schaltet die Hintergrundbewertung nicht ab. Der gewählte Anbieter erhält zulässige Mailheader und einen auf 16.000 Zeichen begrenzten Nachrichtentext mit versionierten Bewertungsfragen; Kürzung bleibt im Detail erkennbar.

Credentials werden ausschließlich aus System-Secrets aufgelöst. TypeSafe verwendet standardmäßig den Namen `TYPESAFE_API_KEY`, OpenAI Decisions `OPENAI_API_KEY`, der kompatible Adapter `EMAIL_CLASSIFICATION_API_KEY`. Verwaltung erfolgt über `/settings?tab=secrets` und den zentralen ENV-Service; persönliche, Organisations- und Prozesswerte sind kein Fallback. Die Admin-/Nutzerantworten enthalten sicheren Zugangsstatus, keine Schlüsselwerte. Ein anonymer kompatibler Endpoint braucht die ausdrückliche private Netzwerkfreigabe und einen bewusst leeren Schlüsselnamen.

PostgreSQL speichert Metadatenindex, Rohbewertungen, menschliche Korrekturen, persönlichen Erledigtzustand, Jobs, Leases und Feed-Snapshots getrennt. Der flüchtige Mailcache ist keine Recovery-Quelle für Bewertungen. Rohbewertungen erhalten Anbieter-, Modell-, Adapter-, Schema-, Wahrscheinlichkeits- und Inhaltsumfangsinformationen. Der Mailfingerprint umfasst Mailboxreferenz, kanonische Provider-ID, Absender, Betreff und Datum; er enthält keinen Bodyhash. Persönliches Erledigen verändert keinen Team-Case, Antwort- oder Mail-Lesestatus.

## OpenAI Decisions

Der zusätzliche Provider `openai-decisions` verwendet die native [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) mit `gpt-6-luna` und dem festen öffentlichen Endpoint `https://api.openai.com/v1/decisions`. Ein eigener Endpoint und private Netzwerkfreigabe sind für diesen Anbieter ausgeschlossen. Die bestehende TypeSafe-Voreinstellung bleibt erhalten.

Choice-, Binary- und Ordinalfragen werden in native Choice-, Predicate- und Scorefragen übersetzt. Wahrscheinlichkeitsverteilungen und separat gelieferte Confidence bleiben erhalten; ordinale Scores behalten ihren gewichteten Wert. Unvollständige oder widersprüchliche Antworten werden abgewiesen. Eine native Refusal beendet die Bewertung mit einem sicheren, nicht wiederholbaren Fehler; Ablehnungstext und Mailinhalt erscheinen nicht in öffentlichen Fehlermeldungen. Ein erfolgreicher Test ist weiterhin kein Spamkalibrierungsnachweis.

## Grenzen und laufende Verarbeitung

| Einstellung | Anfangswert | Bedeutung |
| --- | --- | --- |
| Anbieter / Modell | `typesafe` / `jev-1.13.0` | Austauschbarer Decision-Provider |
| Parallelität | 2 | Global begrenzte gleichzeitig beanspruchte Jobs |
| Modelltimeout | 30 Sekunden | Zusätzlich zu Abbruch-/Lease-Prüfungen |
| Tagesbudget | 2.000 Versuche | UTC-Tag; auch Retry-Claims und mögliche Raw-Wiederverwendung zählen |
| KI-Auswahl | Alle ungelesenen Inbox-Mails plus weitere Inbox-Mails der letzten 30 Tage | Ungelesene ohne Altersgrenze; zusätzlicher Rückblick administrierbar von 1 bis höchstens 30 Tagen |
| Historische Batchgröße | 5.000 neue Nachrichten je Postfach und Scan | Weitere Scans setzen die Auswahl fort; keine dauerhafte Auslassung nach Erreichen der Batchgröße |
| Inbox-Sync | 60 Sekunden | Discovery mindestens alle 60 Sekunden; Runtime-Zyklus standardmäßig 5 Sekunden |

Metadatensync läuft auch bei deaktivierter KI weiter. Er verwendet die menschliche Lesesicht; die KI-Auswahl und der spätere Bodyabruf prüfen zusätzlich die einschlägige AI-/Senderpolicy. Die KI-Auswahl verwendet dieselbe ODER-Regel in Worker, Foreground-Aufnahme und persistenter Queue: ausdrücklich ungelesen oder mit bekanntem Datum innerhalb des zusätzlichen Rückblicks. Ein unbekannter Lesestatus genügt bei bekanntem aktuellem Datum; alte Mails mit unbekanntem Lesestatus oder Datum werden ohne bestätigtes Ungelesen nicht ausgewählt. Gespeicherte passende Rohbewertungen bleiben unabhängig von dieser Auswahl verwendbar. Der Scan lädt pro Zyklus standardmäßig höchstens zwei Seiten pro Postfach mit 50 lokalen beziehungsweise 25 verwalteten Nachrichten. Ungültige, rückwärts laufende oder nicht fortschreitende Fortsetzungsoffsets stoppen den Scan mit teilweiser Coverage. Gültige sichere Fortsetzungsoffsets haben keine feste 10.000-Nachrichten-Grenze; bestätigte Providergrenzen bleiben als teilweise Coverage erkennbar. Foreground-Metadatenaufnahme kann zusätzlich nach derselben Alters-/Lesestatusregel zulässige Bewertungen einreihen; sie verwendet das gemeinsame Tagesbudget. Die historische Batchgröße zählt pro Scan nur neue ausgewählte Referenzen; überlappende Seiten und schon ausgewählte Jobs verbrauchen sie nicht erneut. Nach dem vollständigen Scan wird sie für den nächsten Scan zurückgesetzt.

Vor Claim, Bodyabruf, Modellaufruf und atomarer Ergebnisübernahme wird die Auswahl erneut geprüft. Ein inzwischen gelesenes altes Exemplar wird abgebrochen; eine gelesene aktuelle Mail bleibt zulässig. Explizite aktuelle Providerflags werden vor dem Modellaufruf zusätzlich geprüft. Nicht mehr ausgewählte offene Jobs werden auch bei ausgeschöpftem Tagesbudget abgebrochen. Die Migration normalisiert ältere Rückblicke über 30 Tage einmalig mit neuer Konfigurationsrevision und erhält Rohbewertungen, Korrekturen und Tagesbudget. Nicht ausgewählte Mails erhalten den Status `not_selected`, bleiben unter Alle/Weitere E-Mails erreichbar und zählen nicht als wartende Vorbereitung.

Nur ein bestätigter vollständiger Inboxscan reconciliert extern archivierte Nachrichten. Unbestätigte Seiten, unvollständige Identitäten und abgebrochene Scans bleiben teilweise erfasst oder fehlgeschlagen. Daher beweisen leere Fokuslisten und null ausstehende Jobs keine vollständige Mailboxabdeckung. Die gemeinsame Suche prüft erfasste Absender, Betreff und Vorschau; ein einzelnes klassisches Postfach bietet Ordner und Anbietersuche.

Retries starten bei 2 Sekunden, wachsen exponentiell bis 1 Stunde und verwenden ±20 Prozent Jitter. Ein größeres `Retry-After` wird bis zur Gesamtgrenze von 24 Stunden berücksichtigt. Standardmäßig sind fünf Versuche erlaubt. Rate-Limit, Authentifizierungsfehler, Anbieterfehler und Timeout setzen zusätzlich eine vorübergehende Anbietersperre; Metadatensync hat eigenen Backoff. Das Tagesbudget pausiert neue Claims bis 00:00 UTC. Umschalten und Modellwechsel setzen den bereits verbrauchten Tagesbestand nicht zurück.

Abschalten bricht neue, offene und aktive Bewertungen ab. Modellrequests und klassifizierungsbezogene Bodyabrufe entfallen; Metadatensync bleibt aktiv. Ergebnisübernahme prüft aktuelle Aktivierung, Konfigurationsrevision, Claim, Mailfingerprint, Quelle und Policy. Ein spät zurückkehrendes Ergebnis darf nach Abschalten nicht übernommen werden.

## Aktuelle Rechte und stabile Ansicht

Jeder Feed-/Detail-/Mutationsabruf löst aktuelle Quellen, Owner, Workspace-Rechte und Senderregeln auf. Warme Caches und Feed-Snapshots ersetzen diese Prüfung nicht. Korrekturen brauchen Schreibrechte; persönliches Erledigen braucht Leserechte und eine eigene Version. Konfigurations-, Bewertungs- und persönliche Änderungen verwenden Versionsprüfungen und liefern bei Konflikt 409.

Snapshots halten Reihenfolge und Zeilen während der Pagination stabil. Neue Bewertungen werden ausdrücklich übernommen. Quellenentzug und Inbox-Lifecycle wirken vor einer weiteren Ausgabe. Der Browser prüft die aktuelle Quelle regelmäßig, leert Daten bei nicht bestätigbarem Zugriff und schützt Scope-/Sessionwechsel vor verspäteten Antworten. Eine gestörte Klassifizierungsprojektion darf nach bestätigter Mailautorisation zu normaler Mailausgabe degradieren; eine gestörte Workspace-Autorisation darf keinen Cachezugriff freigeben.

Ein bestätigter direkter Reply/Reply-all speichert für die bereits indexierte Originalnachricht einen lokalen Antwortbeleg. Quelle, Verbindung, Binding, Policy und aktuelle Schreibrechte werden vor und nach dem Versand abgegrenzt. Bei IMAP wird das Answered-Flag mit der ursprünglichen geprüften Verbindung und UIDVALIDITY bestmöglich gesetzt. Ein fehlgeschlagener Flag-Write darf den bestätigten Versand nicht in einen wiederholbaren Fehler verwandeln. Der lokale Beleg übersteht danach widersprechende Provider-Flags; explizites Clear-answered entfernt ihn. Entwürfe, Weiterleitungen und unklare oder fehlgeschlagene Zustellungen erzeugen keinen solchen Beleg. Persönliches Erledigen und Team-Cases bleiben eigenständige Zustände.

Die Startseitenkarte verwendet denselben autorisierten SQL-Fokusfeed mit Limit zwei und vollständigen Gruppenzählern. Sie übernimmt gespeicherte Bewertungen, statt Modelle im UI-Lesepfad aufzurufen. Kategorie, hohe/dringende Priorität, Antwortbedarf und Postfachherkunft bleiben kompakt; detaillierte Wahrscheinlichkeiten gehören in den Reader. Neue Vorbereitung kann pausieren, ohne vorhandene Bewertungen zu verwerfen. Nur bestätigt deaktivierte Vorbereitung wählt die persönliche Legacy-SWR-Vorschau; ein unbekannter Status liefert keinen behaupteten leeren Bestand.

Startseitenlinks tragen eine Nachrichtenreferenz. Der Reader löst deren aktuelle autorisierte Quelle auf und bewahrt eine gespeicherte Classic-Präferenz sowie festgehaltene Entwürfe. Nutzerwechsel und ausdrückliche Zugriffverweigerung verwerfen eingefrorene Kartenvorschauen einschließlich älterer Parallelantworten. Manuelle Navigation konsumiert einen noch laufenden externen Nachrichtenintent; verspätete Ergebnisse oder Timeouts dürfen die neue Auswahl nicht überschreiben.

## Qualitätsprofil und Spamfreigabe

Zentrale Aktivierung erlaubt Vorbereitung und Fokus auch ohne Spamkalibrierung. Die konservativen Startschwellen sind Konfiguration: Choice mindestens 0,65 und Abstand 0,15; Spam positiv ab 0,95 und negativ bis 0,30; Antwortbedarf positiv ab 0,75 und negativ bis 0,25. Zwischenwerte bleiben unsicher. Fehlende Verteilungen oder Confidence bleiben unbekannt. Anbieter-Confidence, relative Auswahlwahrscheinlichkeit und empirisch kalibrierte Zuverlässigkeit sind getrennt zu beurteilen.

Für eine Spamfreigabe muss ein versionierter Bericht folgende Abnahmekriterien erfüllen:

1. Den genauen Anbieter, Endpoint, Modellstand, Adapter, `email-triage.v1`-Schema, Fragen/Kriterien, verwendete Schwellen und Datensatzversion festhalten. Das Qualitätsprofil darf nicht auf ein anderes Setup übertragen werden.
2. Getrennte Entwicklungs-, Kalibrierungs- und unangetastete Testdaten mit geprüften Labels verwenden. Deutsch/Englisch, persönliche/Arbeitsmails, legitime Newsletter, Rechnungen, Sicherheitsmeldungen, Werbung, Spam, gekürzte/HTML-Texte und Prompt-Injection abdecken.
3. Vor Auswertung zulässige Fehlergrenzen und Mindestabdeckung festlegen. Kategorie/Priorität je Klasse und Sprache, Spam-/Antwortbedarf-Precision und Recall, legitime als Spam markierte Mails, Unsicherheitsanteil, Brier Score beziehungsweise Calibration Error sowie Latenz/Kosten auf Testdaten ausweisen. Stichprobengröße und Unsicherheit gehören zum Bericht.
4. Die vereinbarten Grenzen auf Testdaten bestehen und wichtige legitime Mails in den kritischen Abnahmefällen erhalten. Der Bericht enthält die verantwortliche Freigabe und eine unverwechselbare Referenz. Solange repräsentative Daten oder bestandene Grenzen fehlen, bleibt automatische Spamzuordnung deaktiviert.

Die technische Policy verlangt `spamSortingValidated`, eine `calibrationReference` und exakt passende `validatedProviderId`, `validatedModel` und `validatedSchemaVersion`. Die Rohbewertung muss `model_probability` oder `relative_probability` deklarieren. Diese Felder transportieren eine Freigabe; sie berechnen oder belegen sie nicht. Die Adminoberfläche bietet keine freie Qualitätsbestätigung. Ein autorisierter Profilimport muss denselben validierten Settings-CAS verwenden. Anbieter-, Modell-, Endpoint-, Fragenprofil- oder Schwellenänderungen entfernen die gespeicherte Spamfreigabe.

Ohne gültige Freigabe bleibt positiver Modell-Spamverdacht in der Prüfgruppe. Wichtige Nachrichten mit Spamkonflikt bleiben auch mit Freigabe unter Noch prüfen. Eine menschliche Spamkorrektur bleibt unabhängig davon wirksam. Der feste Admin-Beispielrequest, synthetische Canary-Fälle und erfolgreiche reale Einzelrequests prüfen Vertrag und Funktion, liefern aber keine statistische Kalibrierung. Betriebszähler, Tokens und durchschnittliche Latenz sind keine Qualitätsmessung.

## Wiederverwendung und Recovery

| Auslöser | Verhalten / nächste Prüfung |
| --- | --- |
| Modellstörung, Timeout oder Tagescap | Zulässige gespeicherte Bewertungen bleiben verwendbar. Neue Arbeit wartet auf Backoff/Budget; Fehlerstatus bleibt sichtbar. Modellzugang getrennt von IMAP/OAuth prüfen. |
| Fehlender oder unlesbarer Schlüssel | System-Secrets reparieren und festen Beispielrequest prüfen. Kein impliziter Credential-/Anbieterfallback. |
| Prozessneustart oder abgelaufene Lease | Persistente Jobs und Sync-Cursor bleiben erhalten; abgelaufene Claims können erneut beansprucht werden. Keine Mailaktion erneut ausführen. |
| Terminal fehlgeschlagener Job | Bei unveränderter Konfigurationsrevision, Mailfingerprint sowie Binding-/Policyrevision kein automatisches Neu-Einreihen. Erst Ursache beheben; ein autorisiertes Settings-Save mit aktueller erwarteter Revision erzeugt eine neue Revision und erlaubt neue Jobs. Die normale Oberfläche speichert geänderte Konfigurationen. |
| Toggle, Budget-/Laufzeitlimit oder Darstellungsschwelle | Bei unveränderter Identität, Mailfingerprint, Binding-/Policyrevision und Evaluationsfingerprint kann gültiges Raw wiederverwendet werden. Nur die Projektion verändert sich; Korrekturen und persönliches Erledigt bleiben erhalten. Schwellenänderungen entfernen trotzdem die Spamfreigabe. |
| Modell, Endpoint, Schema oder fachliche Kriterien | Evaluationsfingerprint verändert sich. Alte Rohbewertungen gelten für die neue Konfiguration als veraltet und benötigen neue Bewertung; manuelle Korrekturen bleiben separat. |
| Bindungs-/Senderpolicyänderung | Quelle neu autorisieren, Jobs/Claims invalidieren und Coverage neu prüfen. Gültige Inhalte und Korrekturen bleiben gespeichert; Raw ist nur unter passenden aktuellen Revisionen verwendbar. |
| Echter Verbindungs-/Provider-/Accountwechsel | Alte Provideridentitäten und abhängige Indexdaten werden entfernt. Neue Quelle frisch synchronisieren; wiederverwendete IDs dürfen keine alten Bewertungen/Korrekturen erben. Reine Tokenrotation ist kein Identitätswechsel. |
| Archivieren, Papierkorb oder Verschieben aus Inbox | Aus dem Inboxfeed nehmen und offene Inboxarbeit stoppen; gespeicherte Ergebnisse/Korrekturen bleiben erhalten. Erfolgreicher vollständiger Sync erkennt externe Änderungen. |
| Dauerhaftes Löschen / Accountentfernung | Betroffene Indexreferenzen und abhängige Daten entfernen beziehungsweise Quelle deaktivieren und ihre Jobs abbrechen. Andere Postfächer mit gleichen Provider-IDs bleiben unberührt. |

Cachelöschen repariert keine Klassifizierungsdatenbank. Metadaten werden aus aktuell autorisierten Postfächern synchronisiert; Raw darf ausschließlich bei passender Identität, passendem Mailfingerprint und passenden Binding-, Policy- und Evaluationsversionen wiederverwendet werden. Ein unvollständiger Scan rechtfertigt keine pauschale Löschung. Wiederherstellung von Bewertung/Korrektur/Erledigt braucht den konsistenten PostgreSQL-Bestand. Erfolg einer bestehenden Provideraktion bleibt auch bei anschließend gestörter Klassifizierungs-DB erhalten; Versand, Archivierung oder Löschung werden dadurch nicht wiederholt.

## Prüfnachweis getrennt führen

`test:decision-models`, `test:email:classification:policy`, Store-/Postgres-, Admin-/Routes-, Worker-/Index-/Feed-, Enrichment-/Lifecycle-/Rebind- und UI-Tests prüfen unterschiedliche Grenzen. Typecheck, Produktionsbuild und echte Browser-/Mailprovider-Abnahme separat dokumentieren. Providerkompatibilität, bestandene Funktionsprüfung und Spamqualität erhalten jeweils eigene Ergebnisse; offene oder unbekannte Nachweise bleiben ausdrücklich offen.
