# Third-Party License Inventory and Notices Policy

Stand: 2026-07-16

## Umsetzungsstand

Die technische Inventar- und Release-Gate-Implementierung ist am 16. Juli 2026
angelaufen und liegt reproduzierbar im Repository:

- `scripts/generate-third-party-notices.ts` erzeugt das maschinenlesbare
  Inventar und `THIRD_PARTY_NOTICES.md` deterministisch aus Lockfile,
  installierten Lizenzdateien, versionierten Overrides und Non-npm-Komponenten.
- `scripts/refresh-third-party-license-cache.ts` liest fehlende Lizenzdateien
  aus den exakt im Lockfile gepinnten npm-Tarballs und legt den Beleg mit
  Lockfile-Hash reproduzierbar unter `docs/compliance/` ab. Pakete ohne eigenen
  Lizenztext bleiben sichtbar reviewpflichtig.
- `scripts/third-party-license-compliance-test.ts` prueft Drift, MIT-Text und
  Copyright-Zuordnung, Excalidraw inklusive der selbst gehosteten Fonts sowie
  das Entfernen ungenutzter lizenzpflichtiger Pakete.
- `@jspreadsheet/react` und damit das ungenutzte, ausdruecklich
  lizenzpflichtige `@jspreadsheet/formula-pro` wurden aus dem Produkt entfernt.
- Das ebenfalls ungenutzte, von der Unternehmensgroesse abhaengig
  lizenzpflichtige `@remotion/google-fonts` samt `remotion` wurde entfernt.
- Settings -> Rechtliches zeigt Inventarstatus und Release-Blocker; Notices
  und JSON-Inventar sind offline ueber dieselbe ausgelieferte Quelle abrufbar.
- Docker-, Portable-CLI-, Host-CLI- und Electron-Artefakte nehmen Lizenz,
  Notices und Inventar auf. Das Docker-Image erfasst zusaetzlich die exakt
  installierten Debian- und Python-Versionen zur Build-Zeit.
- Die Release-Workflows rufen das strikte kommerzielle Lizenz-Gate vor dem
  Paketieren auf.

Der aktuelle technische Scan umfasst 1.981 Komponenten. Das kommerzielle
Release-Gate bleibt mit 200 Eintraegen absichtlich gesperrt. Darin enthalten
sind die erste verantwortliche oder rechtliche Freigabe, das gegen seinen
aufgeloesten Digest zu pruefende Docker-Basisimage sowie Runtime-Pakete ohne
vollstaendig zugeordneten Lizenztext beziehungsweise Copyright-Hinweis oder
mit reviewpflichtiger Mehrfach-/Copyleft-Lizenz. Im Gesamtinventar sind 1.758
Komponenten `allowed`, 223 `review_required` und keine pauschal `blocked`;
Development-only-Eintraege zaehlen nicht als Release-Blocker. Alle offenen
Punkte stehen einzeln in
`docs/compliance/third-party-components.json`; sie werden nicht durch eine
pauschale KI-Freigabe als erledigt markiert.

Die technische Verifikation am 16. Juli 2026 umfasst:

- TypeScript, ESLint und den Next.js-Produktions-Build,
- deterministischen Generatorlauf und einen negativen kommerziellen
  Release-Gate-Test,
- erzeugte Host- und Portable-CLI-Archive inklusive lesbarer Lizenz,
  Notices, JSON-Inventar und gueltiger SHA-256-Pruefsummen,
- Playwright-E2E fuer die Legal-Ansicht auf Desktop und Mobile sowie die
  Notice-/Inventar-Endpunkte und horizontale Viewport-Passung.

Ein Container wurde dabei nicht gebaut, weil dies fuer diesen Arbeitslauf
nicht beauftragt war. Die Docker-Inventurerfassung ist implementiert, muss
aber zusammen mit Digest und finalem Image-Lieferumfang im spaeteren
verantwortlichen Release-Review ausgefuehrt werden.

## Zweck

Dieses Dokument legt fest, wie alle in Canvas Notebook integrierten Drittanbieter-Komponenten inventarisiert, lizenzrechtlich klassifiziert und mit den erforderlichen Lizenz- und Copyright-Hinweisen ausgeliefert werden. Der erste zwingende Schwerpunkt sind saemtliche MIT-lizenzierten Libraries; der Audit darf dort aber nicht enden, weil das Produkt auch andere oder unvollstaendig deklarierte Lizenzen enthaelt.

Das Ziel ist kein einmaliger Tabellenexport, sondern ein reproduzierbarer Release-Prozess:

1. alle ausgelieferten Drittanbieter-Komponenten erkennen,
2. Lizenztext, Copyright-Hinweise, Version und Quelle verifizieren,
3. die Verwendung und Auslieferungsform gegen eine Policy pruefen,
4. verpflichtende Notices generieren und mit jedem Produktartefakt ausliefern,
5. Drift bei neuen oder aktualisierten Abhaengigkeiten im CI blockieren.

Diese technische Policy ersetzt keine anwaltliche Einzelfallpruefung. Unklare, proprietaere, Copyleft-, Source-Available- oder mehrfach lizenzierte Komponenten brauchen vor kommerzieller Freigabe eine dokumentierte menschliche Entscheidung.

## Aktueller Befund

Der aktuelle Repository-Stand besitzt:

- eine eigene Produktlizenz in `LICENSE`,
- einzelne Lizenzdateien in gebuendelten Seed-Skills,
- Lizenzmetadaten in `package-lock.json`,
- aber keine zentrale, aus dem ausgelieferten Produkt erreichbare Drittanbieter-Lizenzliste und keinen CI-Drift-Check fuer neue Komponenten.

Eine vorlaeufige Auswertung der Lockfile-Metadaten ergibt 2.017 Paket-Eintraege. Davon deklarieren 1.533 `MIT`; 21 Eintraege besitzen kein `license`-Metadatum. Zusaetzlich kommen unter anderem Apache-, ISC-, BSD-, LGPL-, MPL-, FSL- und Mehrfachlizenz-Angaben vor. Diese Zahlen enthalten direkte, transitive, Entwicklungs-, optionale und plattformspezifische Pakete und sind deshalb nur ein Inventar-Startpunkt, keine Aussage ueber den tatsaechlichen Lieferumfang oder die Zulassung.

`@excalidraw/excalidraw` ist aktuell als npm-Abhaengigkeit eingebunden und unter MIT lizenziert. Excalidraw und jeder spaeter wiederverwendete Teil aus `excalidraw-room` oder der offiziellen Collaboration-Implementierung muessen mit exakter Version beziehungsweise Commit, Upstream-Quelle, Lizenztext und Copyright-Hinweis in dieses Inventar aufgenommen werden.

Die MIT-Lizenz des Open-Source-Codes ist von Namen, Logos, Marken und proprietaeren Inhalten der Excalidraw-/Excalidraw+-Website zu trennen. Canvas darf den MIT-Code unter Einhaltung der Lizenz kommerziell integrieren und verkaufen, erhaelt dadurch aber nicht automatisch das Recht, das eigene Produkt als offizielles Excalidraw-Angebot darzustellen oder geschuetzte Marken-/Website-Assets kommerziell zu uebernehmen. Branding und mitkopierte Assets werden deshalb als eigener Pruefpunkt inventarisiert.

## Verbindlicher Scope

Der Audit erfasst nicht nur `dependencies` aus `package.json`, sondern alle Komponenten, die in einem ausgelieferten Artefakt enthalten sind oder zur Laufzeit verteilt werden:

- direkte und transitive npm-Pakete,
- optionale und plattformspezifische npm-Pakete,
- produktiv gebuendelte Teile aus `devDependencies`,
- gepatchte Pakete unter `patches/`,
- kopierter oder angepasster Upstream-Quellcode,
- Seed-Skills, Seed-Plugins, Templates und mitgelieferte Skripte,
- Icons, Fonts, Bilder, Beispielinhalte und sonstige Assets,
- native Binaries und heruntergeladene Runtime-Komponenten,
- Docker-Base-Images und im Image installierte OS-Pakete,
- Electron-, CLI-, Installer- und Release-Artefakte,
- Komponenten, die erst durch Build-, Download- oder Postinstall-Skripte in das Produkt gelangen.

Entwicklungswerkzeuge, die nicht ausgeliefert werden, bleiben im Gesamtinventar sichtbar, werden aber als `development-only` klassifiziert. Die veroeffentlichte Notice-Liste wird aus dem tatsaechlichen Lieferumfang pro Artefakt erzeugt.

## Inventardaten

Jede Komponente benoetigt mindestens:

```ts
type ThirdPartyComponent = {
  name: string;
  versionOrCommit: string;
  sourceUrl: string;
  packagePathOrArtifact: string;
  usage: "runtime" | "build-bundled" | "asset" | "native" | "development-only";
  distributedIn: string[];
  declaredLicense: string;
  verifiedLicense: string;
  licenseTextRef: string;
  copyrightNotices: string[];
  modified: boolean;
  modificationNotice?: string;
  policyDecision: "allowed" | "review_required" | "blocked";
  reviewedBy?: string;
  reviewedAt?: string;
};
```

Paketmetadaten allein gelten nicht als ausreichender Beleg. Bei fehlenden, widerspruechlichen oder zusammengesetzten Angaben werden der Upstream-Lizenztext, die jeweilige Version beziehungsweise der Commit und vorhandene `NOTICE`-/Copyright-Dateien geprueft. Manuelle Overrides muessen Quelle, Begruendung und einen stabilen Hash des geprueften Textes enthalten.

## MIT-spezifische Pflicht

MIT erlaubt grundsaetzlich Nutzung, Aenderung, Veroeffentlichung, Verteilung, Unterlizenzierung und Verkauf. Bedingung ist insbesondere, dass der Copyright-Hinweis und der MIT-Erlaubnistext in allen Kopien oder wesentlichen Teilen erhalten bleiben.

Fuer Canvas folgt daraus:

- Jede ausgelieferte MIT-Komponente wird einzeln oder ueber einen nachweislich identischen gruppierten Lizenztext aufgefuehrt.
- Komponentenname, Version beziehungsweise Commit und Copyright-Inhaber bleiben nachvollziehbar.
- Der vollstaendige MIT-Text wird nicht nur als SPDX-Kuerzel referenziert, sondern im Notice-Artefakt bereitgestellt.
- Bei kopiertem oder veraendertem MIT-Code werden die Originalhinweise erhalten und die eigene Modifikation gekennzeichnet, wo dies die konkrete Upstream-Lizenz oder Projektpraxis verlangt.
- Ein fehlendes `LICENSE`-File im installierten npm-Paket wird nicht als Freigabe interpretiert; die Lizenz wird gegen die exakte Upstream-Version verifiziert und als manueller Datensatz dokumentiert.
- Softwarelizenz und etwaige Marken-/Branding-Rechte werden getrennt bewertet; eine OSS-Lizenz gilt nicht automatisch fuer Namen, Logos oder proprietaere Website-Inhalte.

## Andere Lizenzen und Policy-Gate

Die Umsetzung fuehrt eine versionierte Policy mit drei Ergebnissen ein:

- `allowed`: nach dokumentierter Regel fuer die konkrete Auslieferungsform freigegeben,
- `review_required`: keine Auslieferung, bevor die konkrete Nutzung, Verlinkung, Modifikation und Notice-/Source-Pflicht geprueft wurde,
- `blocked`: darf nicht in das kommerzielle Artefakt gelangen.

`unknown`, fehlende Lizenztexte, unaufgeloeste Mehrfachlizenzen und neue Lizenzkennungen sind immer `review_required`. Copyleft- und Source-Available-Lizenzen duerfen nicht allein aufgrund eines Package-Metadatums automatisch erlaubt werden. Die eigene Sustainable Use License wird getrennt von Drittanbieter-Lizenzen dargestellt und darf deren Rechte oder Notices nicht einschraenken beziehungsweise ueberdecken.

## Geplante Artefakte

Die Implementierungsaufgabe erzeugt mindestens:

- `THIRD_PARTY_NOTICES.md` oder ein gleichwertiges menschenlesbares Root-Artefakt,
- ein maschinenlesbares, versioniertes Komponenten- und Entscheidungsmanifest unter `docs/compliance/`,
- eine Policy-/Override-Datei fuer erlaubte, reviewpflichtige und blockierte Lizenzen,
- einen deterministischen Generator fuer Inventar und Notice-Datei,
- einen CI-Test, der fehlende, unbekannte oder nicht freigegebene Komponenten sowie veraltete Notices blockiert,
- optional ein SPDX- oder CycloneDX-SBOM als zusaetzliches Auslieferungsartefakt.

Generierte Dateien muessen reproduzierbar sein. Ein Dependency-Update gilt erst als fertig, wenn Inventar, Lizenzentscheidung und Notices aktualisiert sind.

## Auslieferung und Auffindbarkeit

Die Notice-Liste muss in jedem relevanten Distributionsweg enthalten und ohne Internetzugang lesbar sein:

- Source-Repository und Release-Archiv,
- Docker-Image,
- portable CLI-/Installer-Pakete,
- Electron-Desktop-Artefakte,
- spaetere On-Premise- oder Managed-Release-Bundles.

Die laufende App erhaelt im Settings-/About-/Legal-Bereich einen sichtbaren Link oder eine Ansicht fuer `Third-Party Notices`. Der Containerpfad und der UI-/API-Pfad verwenden dieselbe generierte Quelle, damit keine divergierenden Listen entstehen.

## Verifikation und Release-Gate

Die spaetere Umsetzung muss mindestens pruefen:

1. Lockfile-Scan und aufgeloesten Produktions-Dependency-Tree.
2. Tatsaechlichen Next.js-, Server-, CLI-, Electron- und Container-Lieferumfang.
3. Alle MIT-Komponenten gegen Lizenztext und Copyright-Hinweis.
4. Alle fehlenden, mehrdeutigen und nicht erlaubten Lizenzangaben gegen manuelle Entscheidungen.
5. Gebuendelte Skills, Plugins, Assets, Fonts, kopierten Quellcode und Patches ausserhalb des npm-Trees.
6. Docker-Base-Image und installierte OS-/Native-Pakete.
7. Reproduzierbarkeit der Notice-Datei und Differenzfreiheit nach erneutem Generatorlauf.
8. Vorhandensein und Lesbarkeit der Notices in jedem Release-Artefakt.

Ein kommerzieller Release darf den Compliance-Check nicht umgehen. Die erste vollstaendige Bestandsaufnahme braucht vor Freigabe eine dokumentierte rechtliche beziehungsweise verantwortliche Abnahme; danach blockiert CI unreviewte Drift.

## Abgrenzung zu Excalidraw-Collaboration

Diese Aufgabe bewertet und dokumentiert die Lizenzlage von Excalidraw sowie aller dafuer wiederverwendeten Komponenten. Die technische Live-Collaboration-Architektur bleibt eine separate Aufgabe und wird nicht in Aufgabe `48` fuer Markdown/Text aufgenommen.
