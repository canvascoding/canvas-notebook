# Third-Party Compliance Runbook

Stand: 2026-07-16

## Zweck und rechtliche Einordnung

Dieses Runbook beschreibt den technischen und organisatorischen Prozess, mit
dem Canvas Notebook Drittanbieter-Lizenzen erfasst, geprueft, ausgeliefert und
bei Releases erneut kontrolliert.

Es dokumentiert einen technischen Compliance-Prozess, ersetzt aber keine
anwaltliche Beratung. Eine KI oder ein Generator kann feststellen, welche
Komponenten und Lizenztexte ausgeliefert werden. Er kann nicht verbindlich
entscheiden, ob eine konkrete kommerzielle Nutzung unter einer unklaren,
mehrfachen, proprietaeren oder Copyleft-Lizenz rechtlich zulaessig ist.

Die entscheidende Trennung lautet:

1. `LICENSE` regelt die von Canvas selbst geschriebenen beziehungsweise von
   Canvas lizenzierbaren Produktteile.
2. Drittanbieter-Code bleibt unter den jeweiligen Drittanbieter-Lizenzen.
3. `THIRD_PARTY_NOTICES.md` und das Komponentenmanifest dokumentieren diese
   Rechte und Pflichten; sie werden nicht durch die Canvas-Lizenz ersetzt.
4. Marken, Namen, Logos, SaaS-Leistungen, API-Nutzungsbedingungen und
   proprietaere Website-Inhalte sind von der Open-Source-Code-Lizenz getrennt.

Canvas Notebook darf daher kommerziell verkauft und ausgeliefert werden, wenn
die eigene Lizenz dies erlaubt und fuer jede enthaltene Drittanbieterkomponente
die jeweilige Lizenz eingehalten wird. Eine MIT-Komponente macht nicht das
gesamte Produkt zu MIT. Umgekehrt darf die Canvas-Lizenz den Empfaengern die
bereits durch MIT oder eine andere Drittanbieter-Lizenz gewaehrten Rechte an
dieser Komponente nicht wieder nehmen.

## Aktueller Freigabestatus

Die technische Umsetzung ist vorhanden und reproduzierbar. Der Bestand vom
16. Juli 2026 umfasst:

| Kennzahl | Stand |
| --- | ---: |
| Komponenten gesamt | 1.981 |
| ausgelieferter Runtime-/Asset-Bestand | 1.473 |
| nur Entwicklung | 508 |
| automatisch beziehungsweise dokumentiert `allowed` | 1.911 |
| `review_required` im Gesamtbestand | 70 |
| pauschal `blocked` | 0 |
| Blocker fuer ein kommerzielles Release | 49 |

Das strikte Release-Gate ist absichtlich gesperrt. Offen sind:

- die erste dokumentierte verantwortliche oder rechtliche Gesamtfreigabe,
- die Bewertung des gepinnten Docker-Basisimages und des konkreten
  Debian-/Python-Lieferumfangs,
- 28 plattform- und versionsspezifische `sharp`-/`libvips`-Positionen,
- die dokumentierte Lizenzwahl fuer `@zone-eu/mailsplit`, `dompurify` und
  `jszip`,
- 16 Runtime-Pakete ohne vollstaendigen exakten Lizenztext oder ohne belastbar
  zugeordneten MIT-Copyright-Hinweis.

Diese Positionen sind keine pauschale Aussage, dass die Komponenten unzulaessig
sind. Sie bedeuten, dass die vorhandenen Belege fuer eine automatische
kommerzielle Freigabe nicht ausreichen oder eine echte Lizenzwahl dokumentiert
werden muss.

## Verbindliche Quellen

| Datei oder Artefakt | Funktion | Bearbeitung |
| --- | --- | --- |
| `LICENSE` | Lizenz fuer Canvas-eigenen Code | bewusst manuell |
| `package-lock.json` | exakter npm-Abhaengigkeitsbestand | durch npm |
| `docs/compliance/third-party-license-policy.json` | erlaubte/reviewpflichtige Lizenzmuster, Paket-Overrides, Non-npm-Komponenten und Release-Freigabe | reviewt manuell |
| `docs/compliance/third-party-license-cache.json` | Lockfile-gebundene Upstream-Belege fuer fehlende Paket-Lizenzdateien | nur ueber Refresh-Skript |
| `docs/compliance/third-party-components.json` | generiertes Komponenten-, Quellen-, Entscheidungs- und Release-Gate-Manifest | nicht direkt bearbeiten |
| `THIRD_PARTY_NOTICES.md` | generierte menschenlesbare Notices | nicht direkt bearbeiten |
| `docs/compliance/runtime-components.json` | im finalen Docker-Image erfasste Debian-/Python-Versionen und Beleg-Hashes | waehrend Image-Build erzeugt |
| `docs/compliance/third-party-review-decisions.md` | versionsgenaue technische Entscheidungen fuer einzelne Review-Blocker | nach abgeschlossener Einzelpruefung manuell |
| `docs/compliance/third-party-release-approval-template.md` | Vorlage fuer menschliche Freigabe und Lizenzentscheidungen | pro Review kopieren/ausfuellen |

Manuelle Korrekturen gehoeren in die Policy oder in einen dort referenzierten,
versionierten Lizenztext. Eine direkte Aenderung der generierten Notices oder
des Komponentenmanifests ist unzulaessig, weil sie beim naechsten Lauf
ueberschrieben wird und keinen reproduzierbaren Nachweis darstellt.

## Was die wichtigsten Lizenzklassen praktisch bedeuten

Die folgende Einordnung ist eine Arbeitsregel fuer das Release-Gate und keine
abschliessende Rechtsberatung.

### MIT, ISC, BSD, 0BSD und aehnliche permissive Lizenzen

Permissive Lizenzen erlauben typischerweise Nutzung, Aenderung, Verteilung und
kommerzielle Nutzung. MIT erlaubt ausdruecklich auch Unterlizenzierung und
Verkauf von Kopien oder wesentlichen Teilen.

Fuer die Auslieferung muessen insbesondere erhalten bleiben:

- der vollstaendige vorgeschriebene Lizenztext,
- der korrekte Copyright-Hinweis,
- gegebenenfalls weitere projektspezifische Notice-Dateien.

Ein SPDX-Kuerzel in `package.json` allein reicht fuer Canvas nicht als
Auslieferungsnachweis. Das Inventar ordnet die exakte Version, die Quelle, den
Text-Hash und die Copyright-Inhaber zu.

### Apache-2.0

Apache-2.0 ist fuer kommerzielle Nutzung grundsaetzlich permissiv, enthaelt aber
zusaetzliche Patent- und Notice-Regeln. Neben dem Lizenztext muessen vorhandene
Upstream-`NOTICE`-Informationen und kennzeichnungspflichtige Aenderungen
geprueft werden. Deshalb darf ein Package-Metadatum nicht eine mitgelieferte
`NOTICE`-Datei verdecken.

### Mehrfach- und Alternativlizenzen

Ausdruecke wie `MIT OR GPL-3.0-or-later` bedeuten, dass fuer die konkrete
Nutzung eine angebotene Alternative ausgewaehlt werden kann. Die Auswahl muss
explizit dokumentiert werden; sie darf nicht nur implizit durch den Generator
erfolgen.

Beispiele im aktuellen Bestand:

- `jszip@3.10.1`: die exakte Version bietet ausdruecklich MIT oder GPLv3 an.
  Canvas hat die MIT-Alternative versionsgenau gewaehlt und in
  `third-party-review-decisions.md` dokumentiert.
- `dompurify@3.4.12`: Canvas hat die angebotene Apache-2.0-Alternative
  versionsgenau gewaehlt. Lizenztext, Copyright-/Lizenzheader, fehlende
  Upstream-`NOTICE`-Datei und Modifikationsstatus sind dokumentiert.
- `@zone-eu/mailsplit@5.4.14`: Canvas hat die angebotene MIT-Alternative
  versionsgenau gewaehlt und Text, Copyright, Commit, fehlende separate
  `NOTICE`-Datei sowie die transitive Runtime-Auslieferung dokumentiert.

Die Freigabe nennt immer Paket, Version, gewaehlt Lizenz, Belegquelle,
Auslieferungsform und Reviewer.

### LGPL, MPL, EUPL, GPL und andere Copyleft-Lizenzen

Copyleft-Lizenzen sind nicht automatisch verboten. Ihre Pflichten haengen aber
von Lizenz, Verknuepfungsart, Modifikation und Auslieferungsform ab. Moegliche
Themen sind beispielsweise:

- Bereitstellung des korrespondierenden Quellcodes,
- Beibehaltung derselben Lizenz fuer veraenderte Dateien oder Bibliotheken,
- Austausch- beziehungsweise Relinking-Moeglichkeiten,
- Aenderungs- und Notice-Pflichten,
- Weitergabe der Lizenz an Empfaenger.

Solche Positionen bleiben `review_required`, bis die konkrete technische
Nutzung und der Distributionsweg dokumentiert bewertet wurden. Das gilt
insbesondere fuer die nativen `libvips`-Bestandteile der plattformspezifischen
`sharp`-Pakete.

### Source-Available, proprietaere oder kommerziell eingeschraenkte Pakete

Eine oeffentlich lesbare Quelle ist nicht automatisch Open Source und ein npm-
Paket ist nicht automatisch kostenlos kommerziell nutzbar. Nutzungsgrenzen nach
Unternehmensgroesse, Feature, Nutzerzahl, Hosting-Modell oder Umsatz werden als
`review_required` oder `blocked` behandelt.

Ungenutzte lizenzpflichtige Pakete werden bevorzugt entfernt. So wurden bereits
`@jspreadsheet/react`/`@jspreadsheet/formula-pro` und
`@remotion/google-fonts`/`remotion` aus dem Produktbestand entfernt.

### Fonts, Icons, Bilder, Seed-Inhalte und kopierter Quellcode

Assets und kopierte Quellteile muessen auch dann erfasst werden, wenn sie nicht
im npm-Produktionsbaum erscheinen. Fuer jedes Element werden mindestens Quelle,
Version oder Commit, Lizenz, Copyright, Veraenderungsstatus und Zielartefakte
dokumentiert.

Bei kopiertem Upstream-Code wird ausserdem festgehalten:

- aus welcher unveraenderlichen Revision die Vorlage stammt,
- welche Dateien oder Funktionen uebernommen wurden,
- welche Canvas-Aenderungen vorgenommen wurden,
- welche Originalhinweise und Aenderungshinweise ausgeliefert werden.

## Excalidraw-spezifische Lizenzlage

Canvas verwendet aktuell `@excalidraw/excalidraw` in Version `0.18.1`. Der
Code und die selbst gehosteten Font-Assets sind im Inventar unter MIT mit
`Copyright (c) 2020 Excalidraw` erfasst.

Damit darf Canvas den eingebetteten Editor grundsaetzlich verwenden, anpassen,
verteilen und als Bestandteil eines kommerziellen Produkts verkaufen, solange
der MIT-Copyright-Hinweis und der MIT-Lizenztext in den ausgelieferten Kopien
beziehungsweise wesentlichen Teilen erhalten bleiben.

Diese Erlaubnis umfasst nicht automatisch:

- das Recht auf Excalidraw-Namen, Logos oder andere Markenverwendung,
- proprietaere Excalidraw+-Leistungen oder Website-Inhalte,
- eine Aussage, Canvas sei ein offizielles Excalidraw-Angebot,
- Rechte aus separaten SaaS-, API- oder Enterprise-Vertraegen.

Fuer die geplante Live-Collaboration gilt zusaetzlich:

- Eine reine Nutzung der oeffentlichen npm-APIs erzeugt keine neue kopierte
  Upstream-Komponente.
- Wird Code aus `excalidraw-app/collab`, `excalidraw-room` oder anderen
  Upstream-Dateien kopiert oder eng abgeleitet, wird er als eigene
  Non-npm-Komponente mit exakter Version/Commit, Dateipfad, MIT-Text,
  Copyright-Hinweis und Veraenderungsnotiz in
  `third-party-license-policy.json` aufgenommen.
- Referenzieren der Architektur oder eigenstaendiges Implementieren desselben
  Protokollgedankens ist von wort- oder codegleicher Uebernahme zu trennen.
- Vor jedem Excalidraw-Upgrade werden Paketlizenz, Fonts, exportierte APIs und
  alle eventuell kopierten Collaboration-Quellen erneut gegen die neue Version
  geprueft.

## Entwicklungsablauf bei Abhaengigkeits- oder Lieferumfangsaenderungen

Der folgende Ablauf ist erforderlich, wenn npm-Pakete, Docker-Image,
apt-/pip-Pakete, Fonts, Assets, Binaries, Plugins, Skills, Templates, Patches
oder kopierter Upstream-Code geaendert werden:

1. Exakte Version beziehungsweise unveraenderlichen Commit festlegen.
2. Lieferumfang und Zielartefakte bestimmen.
3. Lokalen Bestand und Belege aktualisieren:

   ```bash
   npm run licenses:refresh-cache
   npm run licenses:generate
   npm run test:licenses
   ```

4. Diff von Policy, Cache, Komponentenmanifest und Notices lesen.
5. Neue `review_required`- oder `blocked`-Positionen vor dem Release
   entscheiden, ersetzen oder entfernen.
6. Bei Docker-Aenderungen das Image neu bauen und
   `docs/compliance/runtime-components.json` aus dem finalen Image pruefen.
7. Technische Einzelentscheidungen versionsgenau in
   `third-party-review-decisions.md` dokumentieren.
8. Die verantwortliche beziehungsweise rechtliche Gesamtentscheidung mit der
   Freigabevorlage dokumentieren.

`npm run licenses:refresh-cache` ist kein Freigabebefehl. Das Skript sammelt
lediglich reproduzierbare Belege. Fehlende oder widerspruechliche Belege bleiben
offen.

## Build- und Release-Gates

### Bei jedem normalen Build

`npm run build` fuehrt ueber `prebuild` automatisch `npm run test:licenses`
aus. Geprueft werden unter anderem:

- Drift zwischen Lockfile, Policy, Inventar und Notices,
- fehlende beziehungsweise veraenderte Belege,
- die speziellen Excalidraw- und Font-Eintraege,
- die reproduzierbare Generierung.

Dieser Check ist bewusst nicht die kommerzielle Freigabe. Er erlaubt einen
Entwicklungsbuild trotz bereits bekannter menschlicher Reviewpositionen.

### Vor jedem Release

Vor Paketierung, Tag, GitHub Release oder Deployment muss ausgefuehrt werden:

```bash
npm run verify:release
```

Der Befehl kombiniert:

1. das strikte kommerzielle Lizenz-Gate,
2. ESLint,
3. den vollstaendigen Produktions-Build.

Solange eine Freigabe fehlt, eine Abhaengigkeit gedriftet ist oder ein neuer
Blocker existiert, muss dieser Befehl fehlschlagen. Release-Skripte, CI und der
Release-Publisher duerfen den Fehler nicht ueberspringen oder durch einen
normalen `npm run build` ersetzen.

### Einmalige Freigabe gegen wiederkehrende Pruefung

Die erste vollstaendige Bestandsaufnahme braucht einmalig eine dokumentierte
verantwortliche oder rechtliche Freigabe des vorhandenen Bestands. Danach wird
nicht jede unveraenderte Bibliothek bei jedem Release von Grund auf neu
bewertet.

Trotzdem ist die Aufgabe nicht dauerhaft abgeschlossen:

- Jedes Release muss das strikte Gate durchlaufen.
- Jede neue oder aktualisierte Komponente erzeugt erneut einen technischen
  Abgleich.
- Eine geaenderte Lizenz, Quelle, Auslieferungsform oder Nutzung kann eine neue
  menschliche Bewertung ausloesen.
- Das Docker-Basisimage und der tatsaechliche OS-/Python-Lieferumfang muessen
  nach Image-Aenderungen erneut betrachtet werden.
- Sicherheitsupdates duerfen technisch dringend sein, heben die
  Lizenzpruefung fuer die anschliessende kommerzielle Auslieferung aber nicht
  auf.

## Artefakt- und UI-Pruefung

Vor einem kommerziellen Release ist zu pruefen, dass dieselbe freigegebene
Quelle offline erreichbar ist:

| Artefakt | Erwarteter Nachweis |
| --- | --- |
| Source-Release | `LICENSE`, `THIRD_PARTY_NOTICES.md`, Komponentenmanifest |
| Docker-Image | Lizenz, Notices, Komponentenmanifest und Runtime-Inventar |
| Portable CLI | Lizenz, Notices, Komponentenmanifest |
| Host CLI | Lizenz, Notices, Komponentenmanifest |
| Electron | Lizenz, Notices, Komponentenmanifest sowie Electron-/Chromium-Notices |
| laufende App | authentifizierte Legal-Ansicht und Notice-/Inventar-Download |

Die Legal-Ansicht bleibt auch ohne aktivierte kommerzielle Canvas-Lizenz
erreichbar. Unangemeldete Benutzer erhalten keinen Zugriff auf die
authentifizierten Legal-API-Endpunkte.

## Verantwortliche Freigabe

Eine gueltige Freigabe dokumentiert mindestens:

- Reviewer und Rolle,
- Datum,
- Git-Commit, Produktversion und Lockfile-Hash,
- gepruefte Artefakte und Plattformen,
- offene beziehungsweise entschiedene Komponenten,
- gewaehlte Alternative bei Mehrfachlizenz,
- erfuellte Notice-, Source-, Modifikations- und Auslieferungspflichten,
- Entscheidung und nachvollziehbare Begruendung.

Die ausgefuellte Freigabe wird als versioniertes Release-/Compliance-Artefakt
aufbewahrt. Erst danach werden die entsprechenden Policy-Entscheidungen und
`releaseApproval` nachvollziehbar aktualisiert, die generierten Dateien neu
erzeugt und `npm run verify:release` erneut ausgefuehrt.

Vorlage:
`docs/compliance/third-party-release-approval-template.md`.

## Nicht zulaessige Abkuerzungen

- generierte Notices oder das Manifest direkt editieren,
- `review_required` ohne Beleg und benannten Reviewer auf `allowed` setzen,
- nur direkte npm-Abhaengigkeiten betrachten,
- Development- und Runtime-Lieferumfang pauschal gleichsetzen,
- Docker-, Font-, Asset-, Binary- oder kopierten Code ignorieren,
- einen fehlgeschlagenen strikten Check durch einen normalen Build ersetzen,
- MIT-Code, Markenrechte und proprietaere SaaS-Funktionen gleichsetzen,
- eine KI-Antwort als rechtliche Freigabe eintragen.
