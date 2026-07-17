# Third-Party License Inventory and Notices Policy

Stand: 2026-07-17

## Task-51-Abschlussstand

Der statische kommerzielle Release-Gate-Bestand umfasst 2.054 Komponenten:
1.492 werden ausgeliefert, 562 sind Development-/Source-Install-Positionen,
2.004 sind `allowed`, 50 ausschliesslich nicht ausgelieferte Positionen sind
weiter `review_required`, und es gibt null Release-Blocker.

Die frueheren 29 Blocker wurden nicht pauschal freigegeben, sondern technisch
aufgeloest:

- `node-docker-base` ist nur fuer den digest-, snapshot-, versions- und
  hashgebundenen Lieferweg mit Schema-4-Multi-Arch-Evidenz `allowed`.
- Vorher gebuendelte `@img/sharp-*`-Binaries werden aus Docker-Releases
  entfernt. Die problematischen Lockfile-Positionen bleiben sichtbar.
- libvips 8.18.3 wird unveraendert aus dem exakt gehashten Source-Archiv als
  Shared Library gebaut; Sharp 0.34.5 und 0.35.3 werden lokal dagegen gebaut.
- Das CA-Bootstrap stammt aus demselben APT-signierten Debian-Snapshot; danach
  nutzt APT HTTPS. Der Laufzeitstage installiert nur die benoetigten
  Abhaengigkeiten und kein zweites Debian-`libvips42`-Binaerpaket.
- Die fuer den Sharp-Compile benoetigten libvips-Development-Header verbleiben
  im isolierten `deps`-Stage und sind kein Bestandteil des Runtime-Images.
- LGPL-2.1-or-later, Quellarchiv, Buildrezept, Austauschanleitung, per-Arch-
  Inventare und Linkage-/Convert-Belege werden ausgeliefert.
- Der Release-Workflow erzeugt das Multi-Arch-Manifest erst nach
  erfolgreichem amd64-/arm64-Abgleich und archiviert die native Evidenz.

Ein lokaler Docker-Build wurde fuer diesen Stand auf ausdrueckliche
Owner-Vorgabe nicht ausgefuehrt. Deshalb ist die Implementierung statisch
releasefaehig, waehrend die erste konkrete kandidatenbezogene Image-Evidenz
erst durch den naechsten Tag-Workflow entsteht. Ein fehlgeschlagener
Plattformbuild blockiert Manifest und Release.

## Umsetzungsstand

Die technische Inventar- und Release-Gate-Implementierung ist am 16. Juli 2026
umgesetzt und liegt reproduzierbar im Repository:

- `scripts/generate-third-party-notices.ts` erzeugt das maschinenlesbare
  Inventar und `THIRD_PARTY_NOTICES.md` deterministisch aus Lockfile,
  installierten Lizenzdateien, versionierten Overrides und Non-npm-Komponenten.
- `scripts/refresh-third-party-license-cache.ts` liest fehlende Lizenzdateien
  aus den exakt im Lockfile gepinnten npm-Tarballs. Fehlt der Text dort, wird
  zunaechst der veroeffentlichte `gitHead`, danach ein auf einen unveraenderlichen
  Commit aufgeloester Release-Tag und zuletzt ein dokumentierter
  versionsspezifischer Source-Override geprueft. Vollstaendige Lizenzabschnitte
  in Markdown-READMEs werden inklusive ATX- und Setext-Ueberschriften erkannt.
  Quelle, Commit, Begruendung und Lockfile-Hash liegen reproduzierbar unter
  `docs/compliance/`; Pakete ohne belastbaren Text bleiben reviewpflichtig.
  Schema 6 bindet wiederverwendete Belege zusaetzlich an Paketpfad, Version,
  Registry-URL und Integrity-Hash. Nur unveraenderte Artefakte duerfen einen
  vorhandenen Beleg ohne erneute Netzabfrage uebernehmen.
- Die Copyright-Extraktion trennt echte Attributionen von Lizenzboilerplate.
  Saetze ueber `copyright holder`, Haftungsausschluesse oder abstrakte
  Copyright-Pflichten sowie das Wort `COPYRIGHT` in einer reinen URL werden
  nicht mehr faelschlich als Rechteinhaber in den Notices ausgegeben. Das gilt
  ebenfalls fuer README-Anleitungen zum Erhalten, Platzieren oder Filtern von
  Copyright-Kommentaren; `terser@5.49.0` deckt diesen Fall als Regression ab.
- `scripts/third-party-license-compliance-test.ts` prueft Drift, MIT-Text und
  Copyright-Zuordnung, Excalidraw inklusive der selbst gehosteten Fonts sowie
  das Entfernen ungenutzter lizenzpflichtiger Pakete.
- `@jspreadsheet/react` und damit das ungenutzte, ausdruecklich
  lizenzpflichtige `@jspreadsheet/formula-pro` wurden aus dem Produkt entfernt.
- Das ebenfalls ungenutzte, von der Unternehmensgroesse abhaengig
  lizenzpflichtige `@remotion/google-fonts` samt `remotion` wurde entfernt.
- Settings -> Rechtliches zeigt Inventarstatus und Release-Blocker; Notices
  und JSON-Inventar sind offline ueber dieselbe ausgelieferte Quelle abrufbar.
  Die authentifizierten Legal-Endpunkte bleiben auch ohne aktivierte
  kommerzielle Canvas-Lizenz erreichbar; unangemeldete Zugriffe bleiben
  gesperrt.
- Docker-, Portable-CLI-, Host-CLI- und Electron-Artefakte nehmen Lizenz,
  Notices und Inventar auf. Das Docker-Image erfasst zusaetzlich die exakt
  installierten Debian- und Python-Versionen sowie die Hashes ihrer
  Lizenz-/Copyright-Belege zur Build-Zeit.
- `npm run build` startet ueber `prebuild` immer den nicht-strikten
  Drift-/Notice-Check. `npm run verify:release` prueft vor einem Release zuerst
  per skriptfreiem `npm ci --dry-run` die vollstaendige Lockfile-Synchronitaet
  und fuehrt danach das strikte kommerzielle Gate, ESLint und den
  vollstaendigen Produktions-Build aus.
- Der GitHub-Release-Workflow und der lokale Release-Publisher-Ablauf verwenden
  `npm run verify:release` vor Paketierung, Tag und Veroeffentlichung.

Der vorherige technische Scan mit 1.990 Komponenten und 29 Blockern ist durch
den oben dokumentierten Task-51-Abschlussstand ersetzt. Die nachfolgenden
Einzelbefunde bleiben als Audit-Historie erhalten; wo sie eine aktuelle
Blockierung der Docker-/Sharp-Auslieferung behaupten, beschreibt dies den
Schema-3-Ausgangsbefund vor der Source-/Shared-Library-Umstellung.

Die verantwortliche Erstfreigabe wurde am 17. Juli 2026 durch Frank Alexander
Weber dokumentiert. Zehn npm-Pakete und drei Pakete des global installierten
npm sind fuer ihre exakten Versionen unter transparentem
Attributionsrestrisiko freigegeben. Die Entscheidung, Reviewer, bestverfuegbare
Attribution und Upgrade-Ausloeser stehen in
`docs/compliance/third-party-release-approval-2026.7.17.1.md`.

### Historischer Vorfreigabebefund (ersetzt)

Die folgenden Einzelbewertungen erklaeren, warum die Positionen vor der
verantwortlichen Freigabe beziehungsweise vor dem neuen Native-Liefermodell
blockierten. Sie sind keine Aussage ueber den aktuellen Release-Gate-Status.

Die 29 verbleibenden Release-Pruefpositionen gliedern sich in:

- einen Review von Docker-Basisimage-Digest und Debian-/Python-Lieferumfang,
- 28 plattform- und versionsspezifische `sharp`-/`libvips`-Eintraege mit
  noch nicht erfuellten LGPL-/GPL-Source-, Notice- und Relinking-Pflichten.

Die 28 `sharp`-/`libvips`-Positionen sind inzwischen einzeln technisch
untersucht und bleiben bewusst blockierend. Die exakten npm-Archive der
POSIX-/macOS-libvips-Pakete enthalten keinen Lizenztext; die Apache-2.0-Datei
im Repository gilt fuer die Buildskripte und wurde zuvor faelschlich als
LGPL-Beleg zugeordnet. Windows und WASM liefern nur den Apache-Anteil ihrer
zusammengesetzten Lizenz. Ausserdem werden zahlreiche Bibliotheken statisch
in die `libvips`-Binaerdateien beziehungsweise das WASM-Modul eingebaut.
Archivinhalt, Source-Commits, Linking-Bewertung, Corresponding-Source- und
Release-Anforderungen sind in
`docs/compliance/sharp-native-binary-review.md` festgehalten. Eine Freigabe
erfolgt erst mit vollstaendigem Source-/Notice-Bundle, getestetem
Austausch-/Relinking-Weg und benanntem Reviewer.

`jszip@3.10.1` ist als erster Mehrfachlizenz-Fall technisch abgeschlossen:
Der exakte npm-Release und der auf denselben Commit aufgeloeste Upstream-Tag
bieten ausdruecklich MIT oder GPLv3 an. Canvas waehlt MIT und liefert den
vollstaendigen MIT-Text sowie den Upstream-Copyright-Hinweis aus. Die
versionsgenaue Entscheidung steht in
`docs/compliance/third-party-review-decisions.md`.

`dompurify@3.4.12` ist ebenfalls technisch abgeschlossen. Canvas waehlt aus
MPL-2.0 oder Apache-2.0 die Apache-2.0-Alternative. Der exakte npm-Tarball und
Upstream-Commit enthalten keine separate `NOTICE`-Datei; der vollstaendige
Apache-Text und der bestehende DOMPurify-Copyright-/Lizenzheader werden
erhalten. Modifikationen am Paket liegen nicht vor.

`@zone-eu/mailsplit@5.4.14` ist der dritte technisch abgeschlossene
Mehrfachlizenz-Fall. Canvas waehlt aus MIT oder EUPL-1.1+ die MIT-Alternative.
Der exakte npm-Tarball und der identische Upstream-Commit enthalten den
vollstaendigen MIT-Text und keine separate `NOTICE`-Datei. Das unmodifizierte
Paket wird transitiv ueber `imapflow` und `mailparser` ausgeliefert.

Damit sind alle drei zuvor offenen alternativen Lizenzwahlen versionsgenau
entschieden. Neue oder aktualisierte Mehrfachlizenzen werden weiterhin durch
das Release-Gate blockiert, bis eine eigene Entscheidung dokumentiert ist.

Von den 16 Runtime-Paketen mit fehlendem exaktem Lizenz- oder
Copyright-Beleg ist
`@apm-js-collab/code-transformer-bundler-plugins@0.5.0` technisch geprueft,
bleibt aber blockierend: npm-Paket und exakter Commit deklarieren MIT, liefern
jedoch weder eine Lizenzdatei noch einen belastbaren Copyright-Hinweis. Canvas
nimmt den kanonischen MIT-Text auf, erfindet aber keinen Rechteinhaber. Die
zulassigen Aufloesungswege sind in
`docs/compliance/third-party-review-decisions.md` dokumentiert.

`@better-auth/utils@0.4.2` ist ebenfalls technisch geprueft und bleibt
blockierend. Eine signierte npm-Provenance bindet den Tarball an
`v0.4.2` und den exakten Commit; beide deklarieren MIT, enthalten aber weder
Lizenzdatei noch belastbaren Copyright-Hinweis. Der kanonische MIT-Text wird
ausgeliefert, waehrend Autor- und Commit-Metadaten nicht als
Rechteinhabernachweis umgedeutet werden.

`@eigenpal/docx-js-editor@0.5.3` ist technisch geprueft und bleibt
blockierend. npm-Metadaten, README und signierte Provenance belegen die
MIT-Deklaration und den damaligen Commit, der Tarball enthaelt jedoch keinen
Lizenztext oder Copyright-Hinweis und das referenzierte Repository ist
inzwischen nicht mehr oeffentlich erreichbar. Die aktuelle Apache-2.0-
Nachfolge ist als getestete Migrationsoption dokumentiert, gilt aber nicht
rueckwirkend fuer Version `0.5.3`.

`@types/trusted-types@2.0.7` und `@types/yauzl@2.10.3` sind dagegen
abgeschlossen. Ihre exakten npm-Tarballs enthalten vollstaendigen MIT-Text und
`Copyright (c) Microsoft Corporation.`. Der Cache hatte die Dateien nur wegen
der DefinitelyTyped-spezifischen Archivwurzeln uebersehen. Der Extractor
unterstuetzt nun beliebig benannte einzelne Tarball-Wurzeln; ein
Regressionstest sichert beide Pakete.

`client-only@0.0.1` ist technisch geprueft und bleibt blockierend. Der einzige
npm-Release deklariert MIT und verweist auf React, liefert aber weder
Repository/Commit beziehungsweise Provenance noch Lizenzdatei oder
Copyright-Hinweis. Canvas liefert den kanonischen MIT-Text aus, ordnet
npm-Maintainer und React-Branding jedoch keinem Rechteinhaber zu.

`dingbat-to-unicode@1.0.1` ist technisch geprueft und bleibt blockierend. Der
exakte Release-Tag und Commit deklarieren BSD-2-Clause, enthalten aber weder
Lizenztext noch Copyright-Hinweis. Der Paketautor und alle Commit-Autoren
werden ohne expliziten Notice-Beleg nicht als Rechteinhaber eingetragen.

`github-from-package@0.0.0` ist technisch geprueft und bleibt blockierend. Der
exakte Tarball liefert den vollstaendigen MIT-Wortlaut, laesst aber die
Copyright-Zeile aus. Paketautor und fremde kommerzielle Notice-Listen werden
ohne primaeren Upstream-Beleg nicht als Rechteinhabernachweis uebernommen.

`highlightjs-vue@1.0.0` ist abgeschlossen. npm-Release und exakter `gitHead`
deklarieren CC0-1.0; das README verlinkt direkt den Creative-Commons-Deed.
Canvas liefert den vollstaendigen offiziellen CC0-1.0-Legal-Code aus. Ein
MIT-artiger Copyright-Hinweis ist unter CC0 nicht erforderlich.

`https@1.0.0` ist technisch geprueft und bleibt blockierend. Der signierte
exakte npm-Tarball enthaelt nur `package.json`, deklariert ISC und liefert
weder ISC-Text noch Copyright, Repository, Commit oder Provenance. Das Paket
kommt transitiv ueber `pptxgenjs@4.0.1`, obwohl dessen exakter Runtime-Code das
eingebaute `node:https` importiert und die Browser-Mappings beide Varianten
deaktivieren. Eine Entfernung ist deshalb ein sinnvoller Upstream- oder
Dependency-Fix, wird aber nicht als ungepruefte Lockfile-Manipulation im
Lizenzaudit vorgenommen.

`is-reference@1.2.1` ist technisch geprueft und bleibt blockierend. npm-
`gitHead` und der auf denselben Commit dereferenzierte annotierte Tag
`v1.2.1` belegen den exakten Upstream-Stand. Dort deklarieren `package.json`
und README MIT, ein vollstaendiger MIT-Text und Copyright-Hinweis fehlen
jedoch. Canvas liefert den kanonischen Text aus, deutet Paketautor und
Commit-Historie aber nicht als Rechteinhabernachweis um.

`minimist@1.2.8` ist abgeschlossen. Der exakte Release und Tag enthalten den
vollstaendigen MIT-Wortlaut ohne Namenszeile. Das offizielle Upstream-
Repository hat die Projektlizenz spaeter primaer und versioniert um
`Copyright (c) 2013 James Halliday and contributors` ergaenzt; `1.2.8` ist
weiterhin der neueste npm-Release. Canvas liefert den exakten Release-Text
zusammen mit dieser Upstream-Klarstellung aus.

`react-remove-scroll-bar@2.3.8` ist abgeschlossen. Der veroeffentlichte npm-
`gitHead` ist heute nicht mehr erreichbar; der signierte Tarball ist aber
eindeutig und sein Programmcode byte-identisch mit dem erreichbaren Release
`2.3.7`. Der offizielle Upstream ergaenzte anschliessend eine vollstaendige
MIT-Datei mit `Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>`.
Canvas dokumentiert den Vergleich und liefert diese primaere Attribution aus.

`server-only@0.0.1` ist technisch geprueft und bleibt blockierend. Der einzige
signierte npm-Tarball deklariert MIT und verweist auf React, enthaelt aber
weder Autor, Repository, Commit/Provenance, Lizenzdatei noch Copyright-
Hinweis. Das Paket wird direkt an zahlreichen Canvas-Servergrenzen verwendet.
Canvas liefert den kanonischen MIT-Text aus, weist den Code ohne primaeren
Beleg aber weder Meta/React noch Vercel/Next.js oder dem npm-Maintainer zu.

`tr46@0.0.3` und `tr46@6.0.0` sind abgeschlossen. Neben dem MIT-Code enthalten
beide Pakete generierte Unicode-IDNA-Tabellen, deren Source-Kommentare beim
Build entfernt wurden. Reproduzierbare Generatorlaeufe ordnen die Tabellen
bytegenau Unicode 8.0.0 beziehungsweise 17.0.0 zu. Canvas liefert deshalb
zusammengesetzte MIT-/Unicode-Lizenztexte, beide Copyright-Hinweise und klare
Upstream-Transformationshinweise aus; fuer `0.0.3` gilt
`Unicode-DFS-2015`, fuer `6.0.0` `Unicode-3.0`.

`webworkify@1.5.0` ist technisch geprueft und bleibt blockierend. Exakter
npm-`gitHead`, annotierter Tag und vollstaendiger MIT-Wortlaut sind belegt,
die Copyright-Zeile fehlt jedoch seit dem initialen Upstream-Commit bis heute.
Autor- und Contributor-Metadaten werden nicht als Rechteinhabernachweis
umgedeutet. Eine Entfernung muesste neben dem npm-Knoten auch die in
`pica@7.1.1` gebuendelte und ueber Excalidraw ausgelieferte Kopie erfassen.

Damit sind alle zehn Runtime-Pakete ohne vollstaendigen exakten
Lizenz-/Copyright-Beleg technisch einzeln untersucht und seit dem 17. Juli
2026 fuer ihre exakten Versionen durch eine dokumentierte verantwortliche
Einzelfallentscheidung `allowed`. Ihre fehlenden Upstream-Belege bleiben als
Restrisiko sichtbar; Canonical Terms, bestverfuegbare Attribution, Reviewer
und Datum werden ausgeliefert. Jede neue Version muss erneut geprueft werden.

Alle weiterhin `review_required` klassifizierten, aber nicht ausgelieferten
Positionen stehen einzeln in `docs/compliance/third-party-components.json`;
sie wurden nicht durch eine pauschale KI-Freigabe als rechtlich geklaert
markiert.

Die technische Verifikation am 16. Juli 2026 umfasst:

- TypeScript, ESLint und den Next.js-Produktions-Build,
- deterministischen Generatorlauf und einen negativen kommerziellen
  Release-Gate-Test,
- erzeugte Host- und Portable-CLI-Archive inklusive lesbarer Lizenz,
  Notices, JSON-Inventar und gueltiger SHA-256-Pruefsummen,
- einen vollstaendigen `npm run setup`-Neuaufbau mit der lokalen
  Docker-Environment-Datei, Managed-Team-Modus und Postgres,
- das Test-Image
  `sha256:34801b0e58fd994fe45d37f8e811e002e3d713583f1cec395c89b408748d261a`
  auf Basis des gepinnten Node-Image-Digests
  `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`,
- 408 Debian-Pakete aus 276 Source-Paket/Versionspaaren, 48
  Python-Distributionen, die Node-Runtime und 153 Pakete des global
  installierten npm im Schema-3-Test gegen das isoliert neu gebaute finale
  arm64-Image
  `sha256:d8a3666463040b15e03688e32807fd4ff656a7430ee37532e98f3423b1081409`,
- korrigierte PEP-639-Erkennung mit 94 Python-Lizenzdateien einschliesslich
  der zuvor uebersehenen plattformspezifischen PDFium-Build-Lizenzen,
- sechs versionsgenaue Non-npm-Ergaenzungen fuer fehlende pip-/globale-
  npm-Lizenztexte und drei spaeter verantwortlich unter dokumentiertem
  Restrisiko freigegebene globale npm-Einzelfaelle,
- plattformunabhaengige Notice-Generierung: optional installierte
  Paketmetadaten koennen auf macOS und Linux keinen Manifest-Drift mehr
  verursachen,
- byte-identische Host- und Image-Ausgaben fuer
  `THIRD_PARTY_NOTICES.md` und das Komponentenmanifest,
- Playwright-E2E gegen den neu gebauten Container fuer die Legal-Ansicht auf
  Desktop und Mobile, alle drei authentifizierten Notice-/Inventar-Endpunkte,
  horizontale Viewport-Passung und den weiterhin gesperrten anonymen Zugriff.

Die App- und Postgres-Healthchecks waren bereit. Die Collaboration-Capability
blieb in dieser lokalen Testumgebung erwartbar deaktiviert, weil keine
kommerzielle Canvas-Lizenz aktiviert war; WebSocket und Persistenz waren
technisch bereit. Das Legal-Inventar ist davon absichtlich unabhaengig.

## Operatives Compliance-Runbook

Die Architekturpolicy wird durch zwei operative Dokumente ergaenzt:

- `docs/compliance/README.md` erklaert die Trennung zwischen Canvas-Lizenz,
  Drittanbieterrechten, Notices, Marken und SaaS-Bedingungen, die Bedeutung
  der Lizenzklassen, den Aenderungsablauf und die verpflichtenden Build- und
  Release-Gates.
- `docs/compliance/third-party-review-decisions.md` protokolliert
  versionsgenaue technische Einzelentscheidungen mit unveraenderlicher Quelle,
  Lizenzwahl, Auslieferungsform und erfuellten Pflichten.
- `docs/compliance/third-party-release-approval-template.md` ist die
  ausfuellbare Vorlage fuer die erste kommerzielle Bestandsfreigabe und fuer
  spaetere neue oder geaenderte Reviewpositionen.

Die Vorlage selbst ist keine Freigabe. `releaseApproval` in
`docs/compliance/third-party-license-policy.json` darf erst nach einer
nachvollziehbar dokumentierten menschlichen Entscheidung von `pending`
abweichen.

## Einmalige und wiederkehrende Release-Pruefung

Die technische Erfassung ist nicht "fuer immer erledigt". Zwei Ebenen sind zu
unterscheiden:

1. Die erste kommerzielle Bestandsaufnahme braucht einmalig eine dokumentierte
   verantwortliche oder rechtliche Freigabe aller derzeit offenen Positionen.
2. Danach muss jedes Release `npm run verify:release` bestehen. Der Befehl
   blockiert geaenderte Lockfiles, neue oder aktualisierte Komponenten,
   fehlende Lizenzbelege, gedriftete Notices und neue reviewpflichtige
   Entscheidungen.

Ein normaler `npm run build` prueft bei jedem Build bereits die reproduzierbare
Inventar-/Notice-Basis. Ein Release darf sich darauf allein nicht verlassen,
weil der normale Build die bewusst noch offenen menschlichen Entscheidungen
nicht als Fehler behandelt. Deshalb muessen Release Publisher und CI immer den
strengeren Befehl `npm run verify:release` ausfuehren.

Bei jeder Aenderung von `package-lock.json`, Docker-Basisimage, apt-/pip-Paketen,
mitgelieferten Fonts, Assets, Skills, Plugins, Binaries oder kopiertem
Upstream-Code wird das Inventar aktualisiert. Entsteht dabei eine neue
`review_required`-Position, ist nur diese Drift samt Auswirkung und
Auslieferungsform erneut menschlich zu bewerten. Unveraenderte, bereits
dokumentiert freigegebene Komponenten brauchen nicht bei jedem Release erneut
von Grund auf geprueft zu werden.

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

Der Repository-Stand besitzt jetzt:

- eine eigene Produktlizenz in `LICENSE`,
- eine zentrale, aus der App und aus Release-Artefakten erreichbare
  `THIRD_PARTY_NOTICES.md`,
- ein maschinenlesbares Komponentenmanifest mit Lieferumfang,
  Lizenzentscheidung, Text-Hash und exakter Quelle,
- einen Lockfile-gebundenen Belegcache fuer fehlende Paket-Lizenzdateien,
- einen CI-/Release-Drift-Check und ein striktes kommerzielles Release-Gate,
- gesonderte Eintraege fuer Seed-Skills, Fonts, Assets, Binaries, CLI,
  Electron und Docker-Lieferumfang.

Der Generator inventarisiert derzeit 1.968 npm- und 13 Non-npm-Komponenten.
Lockfile-Eintraege allein gelten weiterhin nicht als Freigabe: optionale,
plattformspezifische und verschachtelte Abhaengigkeiten bleiben sichtbar,
waehrend bekannte Build-Werkzeuge und deren Unterabhaengigkeiten korrekt als
`development-only` vererbt werden.

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
