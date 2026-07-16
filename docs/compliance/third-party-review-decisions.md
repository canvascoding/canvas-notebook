# Third-Party Review Decisions

Stand: 2026-07-16

Dieses Dokument protokolliert versionsgenaue technische Lizenzentscheidungen,
die einzelne automatische Release-Blocker aufloesen. Es ersetzt nicht die noch
ausstehende verantwortliche oder rechtliche Freigabe des Gesamtinventars.

Eine Position wird hier erst als technisch abgeschlossen dokumentiert, wenn
Paketversion, unveraenderlicher Upstream-Stand, angebotene Lizenz, ausgewaehlte
Alternative, Copyright-Hinweis, Auslieferungsform und erfuellte Pflichten
nachvollziehbar sind.

## 1. `jszip@3.10.1`

Status: technische Lizenzwahl abgeschlossen; Gesamtfreigabe weiterhin
ausstehend.

| Feld | Entscheidung |
| --- | --- |
| npm-Paket | `jszip@3.10.1` |
| npm-Tarball | `https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz` |
| npm-Integrity | `sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==` |
| npm-`gitHead` | `0f2f1e4d0509514417db83fe5b86bde90e0ffe8d` |
| Upstream-Tag | `v3.10.1`; dereferenziert auf denselben Commit `0f2f1e4d0509514417db83fe5b86bde90e0ffe8d` |
| deklarierte Lizenz | `MIT OR GPL-3.0-or-later` |
| gewaehlte Alternative | `MIT` |
| verifizierter Beleg | `https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown` |
| Copyright | `Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso` |
| Canvas-Modifikation | keine |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der exakte Upstream-Lizenztext sagt ausdruecklich, dass der Lizenznehmer JSZip
wahlweise unter MIT oder GPLv3 verwenden darf. Canvas waehlt fuer alle
ausgelieferten Kopien der Version `3.10.1` die MIT-Alternative.

Erfuellte Pflichten:

- der vollstaendige MIT-Text wird in `THIRD_PARTY_NOTICES.md` ausgeliefert,
- der Upstream-Copyright-Hinweis bleibt dem Paket zugeordnet,
- Paketname, Version, Quelle, Commit, Text-Hash und Zielartefakte stehen im
  maschinenlesbaren Inventar,
- es wird keine GPL-Lizenzierung von Canvas oder anderen separaten
  Produktbestandteilen behauptet,
- bei einem JSZip-Upgrade muss die Lizenzwahl gegen die neue exakte Version
  erneut verifiziert werden.

## 2. `dompurify@3.4.12`

Status: technische Lizenzwahl abgeschlossen; Gesamtfreigabe weiterhin
ausstehend.

| Feld | Entscheidung |
| --- | --- |
| npm-Paket | `dompurify@3.4.12` |
| npm-Tarball | `https://registry.npmjs.org/dompurify/-/dompurify-3.4.12.tgz` |
| npm-Integrity | `sha512-zQvGet8Z2sWbQhCmfFz/T5QWH2oBmjnqK3qvOjaqaNLrLEF912WamU+ohnTp0TCep/MFVHpdJuCZEdFOdTnEFg==` |
| npm-`gitHead` | `a9ca1e537422319a557a9a2aa61f003b23b4a197` |
| Upstream-Tag | `3.4.12`; dereferenziert auf denselben Commit `a9ca1e537422319a557a9a2aa61f003b23b4a197` |
| deklarierte Lizenz | `MPL-2.0 OR Apache-2.0` |
| gewaehlte Alternative | `Apache-2.0` |
| verifizierter Beleg | `https://github.com/cure53/DOMPurify/blob/3.4.12/LICENSE` |
| Copyright | `(c) Cure53 and other contributors` |
| Canvas-Modifikation | keine |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der exakte npm-Release und der zugehoerige Upstream-Stand bieten DOMPurify
wahlweise unter MPL-2.0 oder Apache-2.0 an. Canvas waehlt fuer alle
ausgelieferten Kopien der Version `3.4.12` die Apache-2.0-Alternative.

Die Tarball-Pruefung hat `LICENSE`, `LICENSE-MPL` und `src/license_header`,
aber keine separate `NOTICE`-Datei ergeben. Dasselbe gilt fuer den exakten
Upstream-Commit. Die ausgelieferten DOMPurify-Bundles enthalten ihren
versionsgenauen `@license`-Header bereits.

Erfuellte Pflichten:

- der vollstaendige Apache-2.0-Text wird in `THIRD_PARTY_NOTICES.md`
  ausgeliefert,
- der DOMPurify-Copyright- und Lizenzheader bleibt in den gebuendelten Dateien
  erhalten und wird zusaetzlich im Komponentenmanifest zugeordnet,
- eine Upstream-`NOTICE`-Datei muss fuer diese Version nicht mitgeliefert
  werden, weil weder npm-Tarball noch Quellstand eine solche Datei enthalten,
- Canvas nimmt keine Aenderung am DOMPurify-Paket vor; bei kuenftigen
  Modifikationen muessen die Apache-Kennzeichnungspflichten erneut geprueft
  werden,
- die Apache-2.0-Patentregeln gelten fuer die unter dieser Alternative
  erteilten Rechte,
- bei einem DOMPurify-Upgrade werden Lizenzangebot, `NOTICE`-Bestand,
  Copyright und Modifikationsstatus erneut verifiziert.

## 3. `@zone-eu/mailsplit@5.4.14`

Status: technische Lizenzwahl abgeschlossen; Gesamtfreigabe weiterhin
ausstehend.

| Feld | Entscheidung |
| --- | --- |
| npm-Paket | `@zone-eu/mailsplit@5.4.14` |
| npm-Tarball | `https://registry.npmjs.org/@zone-eu/mailsplit/-/mailsplit-5.4.14.tgz` |
| npm-Integrity | `sha512-rz0FQOhN3Vq1XrSeSSa9+dPcaFbBxmQPjiZm6zS9oxdVHV7rOWIAYX3yP2YAUf0qBncY8CI+NogzPCmMVrMXcw==` |
| npm-`gitHead` | `ce3e52530b56627c78c78f44fc42e61d71c4c6d0` |
| Upstream-Tag | `v5.4.14`; Lightweight-Tag auf demselben Commit `ce3e52530b56627c78c78f44fc42e61d71c4c6d0` |
| deklarierte Lizenz | `MIT OR EUPL-1.1+` |
| gewaehlte Alternative | `MIT` |
| verifizierter Beleg | `https://github.com/zone-eu/mailsplit/blob/v5.4.14/LICENSE.MIT` |
| Copyright | `Copyright (c) 2011-2019, 2024 Andris Reinman and Zone Media OÜ` |
| Canvas-Modifikation | keine |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der exakte npm-Release und der identische Upstream-Commit bieten MailSplit
wahlweise unter MIT oder EUPL-1.1+ an. Canvas waehlt fuer alle ausgelieferten
Kopien der Version `5.4.14` die MIT-Alternative. Das Paket wird transitiv ueber
`imapflow` und `mailparser` in den Runtime-Bestand aufgenommen.

Die Tarball-Pruefung hat `LICENSE.MIT` und `LICENSE.EUPL-1.2`, aber keine
separate `NOTICE`-Datei ergeben.

Erfuellte Pflichten:

- der vollstaendige mit der Version ausgelieferte MIT-Text wird in
  `THIRD_PARTY_NOTICES.md` aufgenommen,
- der Copyright-Hinweis von Andris Reinman und Zone Media OÜ bleibt dem Paket
  zugeordnet,
- Paketname, Version, npm-Integritaet, Commit, Quelle, Text-Hash und
  Zielartefakte stehen im maschinenlesbaren Inventar,
- es wird keine EUPL-Lizenzierung von Canvas oder anderen separaten
  Produktbestandteilen behauptet,
- bei einem MailSplit-Upgrade werden die angebotenen Alternativen,
  Copyright-/Notice-Dateien und der Modifikationsstatus erneut verifiziert.

## 4. `@apm-js-collab/code-transformer-bundler-plugins@0.5.0`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `@apm-js-collab/code-transformer-bundler-plugins@0.5.0` |
| npm-Tarball | `https://registry.npmjs.org/@apm-js-collab/code-transformer-bundler-plugins/-/code-transformer-bundler-plugins-0.5.0.tgz` |
| npm-Integrity | `sha512-YxLBY5nGlurL7QeJLq6e5g0ouBpAp0pwgyA/5rHXEXwhiPLn9ZHbT+Y2LlP90GT872cSocfjWRYu/fnpuBudNQ==` |
| npm-`gitHead` | `9443e2a3d03b36eeaea5717b31f9c1ffa7255dce` |
| Upstream-Tag | fuer `0.5.0` ist kein Release-Tag vorhanden; npm-`gitHead` ist der unveraenderliche Beleg |
| deklarierte Lizenz | `MIT` |
| verifizierter Lizenzbeleg | `license: MIT` in `package.json` des npm-Releases und exakten Commits |
| fehlender Beleg | Lizenzdatei und belastbarer Copyright-Hinweis |
| Canvas-Modifikation | keine |
| Herkunft | transitive Runtime-Abhaengigkeit von `@sentry/server-utils@10.65.0` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der npm-Tarball enthaelt nur `README.md`, `package.json` und Build-Ausgaben.
Der exakte Source-Commit enthaelt ebenfalls keine `LICENSE`-, `NOTICE`- oder
Copyright-Datei und keinen entsprechenden Source-Header. Das Repository bietet
auch fuer neuere Releases bis `0.7.1` aktuell keinen solchen Beleg.

Technische Entscheidung:

- Paket, Version, npm-Integritaet, Source-Commit und MIT-SPDX-Deklaration sind
  jetzt reproduzierbar dokumentiert.
- Canvas nimmt den kanonischen MIT-Text in die Notices auf, damit die
  erklaerten Lizenzbedingungen nicht fehlen.
- Es wird kein Copyright-Inhaber aus Commit-Autoren, GitHub-Contributors oder
  Organisationsnamen abgeleitet, weil Autorenschaft nicht automatisch die
  Rechteinhaberschaft beweist.
- Der Release-Blocker bleibt bestehen. Er kann belastbar durch einen
  korrigierten Upstream-Release mit Lizenz-/Copyright-Hinweis, Entfernung oder
  Ersatz der Abhaengigkeit oder eine dokumentierte menschlich-rechtliche
  Einzelfallentscheidung aufgeloest werden.

## 5. `@better-auth/utils@0.4.2`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `@better-auth/utils@0.4.2` |
| npm-Tarball | `https://registry.npmjs.org/@better-auth/utils/-/utils-0.4.2.tgz` |
| npm-Integrity | `sha512-AUxrvu+HaaODsUyzDxFgwd/8RZ1yZaYo42LXKSrU2oGgR38pS1ij8nqQKNgtTWoYGpNevNXtCfgTy6loHveW9A==` |
| npm-Provenance | signierte SLSA-Provenance fuer `refs/tags/v0.4.2` |
| Upstream-Tag | `v0.4.2`; dereferenziert auf Commit `b20329a32d78f1f9bcc088bbd6f982b28c4192f1` |
| deklarierte Lizenz | `MIT` |
| verifizierter Lizenzbeleg | `license: MIT` in `package.json` des npm-Releases und exakten Commits |
| fehlender Beleg | Lizenzdatei und belastbarer Copyright-Hinweis |
| npm-Autor | `Bereket Engida` |
| Canvas-Modifikation | keine |
| Herkunft | transitive und direkte Runtime-Abhaengigkeit innerhalb von `better-auth@1.6.23` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Die signierte npm-Provenance bindet den veroeffentlichten Tarball an den
GitHub-Workflow, Tag und Commit. Tarball und exakter Source-Commit enthalten
jedoch nur `README.md`, `package.json`, Quell- beziehungsweise Build-Dateien;
eine `LICENSE`-, `NOTICE`- oder Copyright-Datei und entsprechende Source-Header
fehlen.

Technische Entscheidung:

- npm-Integritaet, signierte Provenance, Tag, Commit und MIT-Deklaration sind
  reproduzierbar dokumentiert.
- Canvas nimmt den kanonischen MIT-Text in die Notices auf.
- Der npm-Autor und die Commit-Autoren werden nicht automatisch als
  Copyright-Inhaber eingetragen, weil Autorenschaft und Rechteinhaberschaft
  nicht zwingend identisch sind.
- Der Release-Blocker bleibt bis zu einem korrigierten Upstream-Release,
  Entfernung/Ersatz oder einer dokumentierten menschlich-rechtlichen
  Einzelfallentscheidung bestehen.

## 6. `@eigenpal/docx-js-editor@0.5.3`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `@eigenpal/docx-js-editor@0.5.3` |
| npm-Tarball | `https://registry.npmjs.org/@eigenpal/docx-js-editor/-/docx-js-editor-0.5.3.tgz` |
| npm-Integrity | `sha512-48AKhvzbzs3KViajI3ecRU80kqPLn2cFfCAD3QepLNhL5PkB6lJTk5FEFQLw8FUS5RhhjpdDNyMuK3n4Fleo0Q==` |
| npm-`gitHead` | `e06dfceae557f8c1607a28618a99a34be8fed1fb` |
| npm-Provenance | signierte SLSA-Provenance fuer Branch `0.x` und denselben Commit |
| deklarierte Lizenz | `MIT` |
| zusaetzlicher Hinweis | Das mitgelieferte README zeigt einen MIT-Badge und verlinkt eine nicht mehr erreichbare Upstream-Lizenzdatei. |
| fehlender Beleg | Lizenzdatei und belastbarer Copyright-Hinweis fuer Version `0.5.3` |
| npm-Autor | `EigenPal` |
| Canvas-Modifikation | keine |
| Herkunft | direkte Runtime-Abhaengigkeit fuer den DOCX-Editor |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Die signierte npm-Provenance bindet den veroeffentlichten Tarball an den
damaligen GitHub-Workflow und Commit. Der Tarball enthaelt jedoch keine
`LICENSE`-, `NOTICE`- oder Copyright-Datei. Das in den Paketmetadaten
referenzierte Repository ist aktuell nicht mehr oeffentlich erreichbar, sodass
der exakte Commit nicht gegen eine ehemalige Root-Lizenz geprueft werden kann.

Die aktuelle Nachfolge `@eigenpal/docx-editor-react@1.9.0` deklariert
`Apache-2.0`, und die aktuelle offizielle Produktseite bezeichnet die
1.x-Generation ebenfalls als Apache-2.0. Das ist eine belastbare
Migrationsoption, aber kein rueckwirkender Lizenz- oder Copyright-Beleg fuer
den ausgelieferten 0.5.3-Tarball. Die Migration besitzt laut Upstream
API-Aenderungen und wird deshalb nicht als blinder Dependency-Tausch im
Lizenzaudit ausgefuehrt.

Technische Entscheidung:

- npm-Integritaet, `gitHead`, signierte Provenance, MIT-Deklaration und
  README-Hinweis sind dokumentiert.
- Canvas nimmt den kanonischen MIT-Text in die Notices auf.
- `EigenPal` wird nicht ohne exakten Notice-Beleg als Copyright-Inhaber
  eingetragen.
- Der Blocker kann durch einen belastbaren historischen Upstream-Beleg, eine
  getestete Migration zur Apache-2.0-Nachfolge, Entfernung oder eine
  dokumentierte menschlich-rechtliche Einzelfallentscheidung aufgeloest
  werden.

## 7. `@types/trusted-types@2.0.7` und `@types/yauzl@2.10.3`

Status: technische Lizenzbelege abgeschlossen; beide Komponenten `allowed`.

| Feld | `@types/trusted-types` | `@types/yauzl` |
| --- | --- | --- |
| Version | `2.0.7` | `2.10.3` |
| npm-Tarball | `https://registry.npmjs.org/@types/trusted-types/-/trusted-types-2.0.7.tgz` | `https://registry.npmjs.org/@types/yauzl/-/yauzl-2.10.3.tgz` |
| Lizenz | `MIT` | `MIT` |
| Lizenzdatei | `trusted-types/LICENSE` | `yauzl/LICENSE` |
| Copyright | `Copyright (c) Microsoft Corporation.` | `Copyright (c) Microsoft Corporation.` |
| Lizenztext-SHA-256 | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |
| Canvas-Modifikation | keine | keine |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Beide exakten npm-Tarballs enthielten bereits den vollstaendigen MIT-Text und
den Microsoft-Copyright-Hinweis. Der Audit-Cache hatte diese Dateien
faelschlich uebersehen, weil der Extractor ausschliesslich `package/` als
Tarball-Wurzel erwartete. DefinitelyTyped verwendet hier dagegen
`trusted-types/` beziehungsweise `yauzl/`.

Technische Korrektur:

- Der Cache-Extractor entfernt nun generisch genau einen Archivwurzelordner,
  unabhaengig von dessen Namen.
- Der Cache wurde aus den exakt im Lockfile gepinnten Tarballs neu erzeugt.
- Beide Komponenten referenzieren jetzt Tarball, Lizenztext-Hash und
  Copyright-Hinweis und sind `allowed`.
- Ein Regressionstest sichert beide nicht standardmaessigen Tarball-Wurzeln
  und den exakten MIT-Beleg ab.

## 8. `client-only@0.0.1`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `client-only@0.0.1` |
| npm-Tarball | `https://registry.npmjs.org/client-only/-/client-only-0.0.1.tgz` |
| npm-Integrity | `sha512-IV3Ou0jSMzZrd3pZ48nLkT9DA7Ag1pnPzaiQhpW7c3RbcqqzvzzVu+L8gfqMp/8IM2MQtSiqaCxrrcfu8I8rMA==` |
| veroeffentlicht | 3. September 2022 |
| deklarierte Lizenz | `MIT` |
| Homepage/Issues | React-Homepage und `facebook/react`-Issue-Tracker |
| npm-Maintainer | `sebmarkbage` |
| fehlender Beleg | Repository, Commit/Provenance, Lizenzdatei und Copyright-Hinweis |
| Canvas-Modifikation | keine |
| Herkunft | transitive Runtime-Abhaengigkeit von `styled-jsx@5.1.6` und `next@16.2.10` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der exakte Tarball enthaelt ausschliesslich `package.json`, die leere
`index.js` und `error.js`. Die Paketmetadaten deklarieren MIT und nennen React
als Homepage beziehungsweise Issue-Tracker, enthalten aber keine
Source-Repository-Angabe. npm veroeffentlicht weder `gitHead` noch signierte
Provenance fuer diesen Release.

Technische Entscheidung:

- Version, Tarball-Integritaet, Inhalt, MIT-Deklaration und Herkunft sind
  dokumentiert.
- Canvas nimmt den kanonischen MIT-Text in die Notices auf.
- Weder der npm-Maintainer noch React-/Meta-/Vercel-Branding werden ohne
  expliziten Notice-Beleg als Copyright-Inhaber eingetragen.
- Der Blocker bleibt bis zu einem belastbaren Upstream-Nachweis,
  Entfernung/Ersatz oder einer dokumentierten menschlich-rechtlichen
  Einzelfallentscheidung bestehen.

## 9. `dingbat-to-unicode@1.0.1`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `dingbat-to-unicode@1.0.1` |
| npm-Tarball | `https://registry.npmjs.org/dingbat-to-unicode/-/dingbat-to-unicode-1.0.1.tgz` |
| npm-Integrity | `sha512-98l0sW87ZT58pU4i61wa2OHwxbiYSbuxsCBozaVnYX2iCnr3bLM3fIes1/ej7h1YdOKuKt/MLs706TVnALA65w==` |
| Upstream-Tag | `js-1.0.1`; annotierter Tag auf Commit `b27f259b49907f99b1b9097abba5a9668106b779` |
| deklarierte Lizenz | `BSD-2-Clause` |
| Paketautor | `Michael Williamson <mike@zwobble.org>` |
| fehlender Beleg | BSD-2-Clause-Lizenztext und Copyright-Hinweis |
| Canvas-Modifikation | keine |
| Herkunft | transitive Runtime-Abhaengigkeit von `mammoth@1.12.0` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der exakte Tag enthaelt den JavaScript-Release unter `js/`; dessen
`package.json` ist in Version, Inhalt, Autor und BSD-2-Clause-Deklaration
identisch zum npm-Release. Weder der Source-Tree noch die npm-Tarballs der
Versionen `1.0.0` und `1.0.1` enthalten eine Lizenz-, Notice- oder
Copyright-Datei beziehungsweise entsprechende Source-Header.

Alle bis zum Release sichtbaren Repository-Commits stammen von Michael
Williamson. Diese Autorenlage ist ein nuetzlicher Recherchehinweis, aber kein
ausdruecklicher Nachweis dafuer, welcher Rechtstraeger den Copyright-Hinweis
tragen muss.

Technische Entscheidung:

- Tarball, Integritaet, Upstream-Tag, Commit und BSD-2-Clause-Deklaration sind
  reproduzierbar dokumentiert.
- Canvas erfindet weder Lizenzwortlaut mit eingesetztem Platzhalter noch einen
  Copyright-Inhaber.
- Der Blocker bleibt bis zu einem korrigierten Upstream-Beleg,
  Entfernung/Ersatz oder einer dokumentierten menschlich-rechtlichen
  Einzelfallentscheidung bestehen.

## 10. `github-from-package@0.0.0`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `github-from-package@0.0.0` |
| npm-Tarball | `https://registry.npmjs.org/github-from-package/-/github-from-package-0.0.0.tgz` |
| npm-Integrity | `sha512-SyHy3T1v2NUXn29OsWdxmK6RwHD+vkj3v8en8AOBZ1wBQ/hCAQ5bAQTD02kW4W9tUp/3Qh6J8r9EvntiyCmOOw==` |
| veroeffentlicht | 29. Dezember 2012 |
| deklarierte Lizenz | `MIT` |
| Lizenzdatei | vollstaendiger MIT-Wortlaut ohne Copyright-Zeile |
| Paketautor | `James Halliday <mail@substack.net>` |
| ehemaliges Repository | `substack/github-from-package`, aktuell nicht oeffentlich erreichbar |
| fehlender Beleg | belastbarer primaerer Copyright-Hinweis |
| Canvas-Modifikation | keine |
| Herkunft | transitive Runtime-Abhaengigkeit von `prebuild-install@7.1.3` und `better-sqlite3@12.11.1` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Die im exakten Tarball enthaltene Datei `LICENSE` umfasst die MIT-
Nutzungsrechte, Bedingungen und Haftungsregelung, laesst aber den eigentlichen
Copyright-Hinweis aus. Damit ist der Lizenzwortlaut belegbar, die verlangte
Attribution jedoch nicht.

Mehrere kommerzielle Drittanbieter-Notice-Listen ordnen das Paket James
Halliday zu. Diese Listen sind voneinander abgeleitete Sekundaerquellen und
ersetzen keinen Upstream-Beleg. Das in den Paketmetadaten referenzierte
Repository ist aktuell nicht mehr oeffentlich erreichbar.

Technische Entscheidung:

- Exakter Tarball, Integritaet, MIT-Datei und deren Text-Hash werden
  ausgeliefert und inventarisiert.
- Der Paketautor wird ohne primaere Copyright-Zeile nicht automatisch als
  Rechteinhaber eingetragen.
- Der Blocker bleibt bis zu einem historischen primaeren Upstream-Beleg,
  Entfernung/Ersatz oder einer dokumentierten menschlich-rechtlichen
  Einzelfallentscheidung bestehen.

## 11. `highlightjs-vue@1.0.0`

Status: technischer Lizenzbeleg abgeschlossen; Komponente `allowed`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `highlightjs-vue@1.0.0` |
| npm-Tarball | `https://registry.npmjs.org/highlightjs-vue/-/highlightjs-vue-1.0.0.tgz` |
| npm-Integrity | `sha512-PDEfEF102G23vHmPhLyPboFCD+BkMGu+GuJe2d9/eH4FsCwvgBpnc9n0pGE+ffKdph38s6foEZiEjdgHdzp+IA==` |
| npm-`gitHead` | `2a0d197ec24ba70e019e12a13bd42f006124506a` |
| deklarierte Lizenz | `CC0-1.0` |
| Upstream-Beleg | `package.json` und README am exakten Commit; README verlinkt den offiziellen CC0-1.0-Deed |
| vollstaendiger Text | offizieller Creative-Commons-Legal-Code unter `docs/compliance/license-texts/CC0-1.0.txt` |
| Text-SHA-256 | `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |
| Canvas-Modifikation | keine |
| Herkunft | transitive Runtime-Abhaengigkeit von `react-syntax-highlighter@16.1.1` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der npm-Release und der exakte Upstream-Commit deklarieren CC0-1.0. Das README
verlinkt unmittelbar den Creative-Commons-Deed. Im Gegensatz zur MIT-Lizenz
verlangt CC0 keinen zu erhaltenden Copyright-Hinweis; entscheidend sind die
nachweisbare Zuordnung der Freigabe und die vollstaendigen Bedingungen
einschliesslich Public-License-Fallback und Einschraenkungen fuer Marken-,
Patent- und Drittpersonenrechte.

Technische Entscheidung:

- Der unveraenderte offizielle CC0-1.0-Legal-Code wird versioniert und in den
  Third-Party Notices ausgeliefert.
- Paket, Version, npm-Integritaet, `gitHead`, Quelle und Text-Hash sind
  reproduzierbar zugeordnet.
- Ein Regressionstest sichert Lizenz, Commit und exakten Legal-Code-Hash.
- Die Komponente ist damit technisch `allowed`; bei einem Upgrade wird die
  CC0-Zuordnung erneut gegen die neue Version geprueft.

## 12. `https@1.0.0`

Status: technisch geprueft, weiterhin `review_required`.

| Feld | Ergebnis |
| --- | --- |
| npm-Paket | `https@1.0.0` |
| npm-Tarball | `https://registry.npmjs.org/https/-/https-1.0.0.tgz` |
| npm-Integrity | `sha512-4EC57ddXrkaF0x83Oj8sM6SLQHAWXw90Skqu2M4AEWENZ3F02dFJE/GARA8igO79tcgYqGrD7ae4f5L3um2lgg==` |
| Tarball-SHA-512 | `e040b9edd757ae4685d31f373a3f2c33a48b4070165f0f744a4aaed8ce0011610d677174d9d14913f180440f2280eefdb5c818a86ac3eda7b87f92f7ba6da582` |
| veroeffentlicht | 20. Maerz 2015 |
| deklarierte Lizenz | `ISC` |
| Paketautor | `hardus van der berg <hardus@sunfork.com>` |
| Tarball-Inhalt | ausschliesslich `package.json`; die deklarierte `index.js` fehlt |
| fehlender Beleg | ISC-Lizenztext, Copyright-Hinweis, Repository, Commit und Provenance |
| Canvas-Modifikation | keine |
| Herkunft | transitive Runtime-Abhaengigkeit von `pptxgenjs@4.0.1` |
| Auslieferung | Source-Release, Next.js-Server, Docker-Image und Electron-Web-App |

Der exakte npm-Tarball ist durch npm-Integrity und Registry-Signatur
identifizierbar. Er enthaelt jedoch keinen ausfuehrbaren Paketinhalt und keinen
Lizenz- oder Copyright-Beleg. Der einzige Lizenzhinweis ist das Feld
`"license": "ISC"` in `package.json`. Die Autor-Metadaten werden nicht als
Nachweis eines Copyright-Inhabers umgedeutet.

`pptxgenjs@4.0.1` deklariert dieses Paket als Abhaengigkeit. Der ausgelieferte
Code des exakt gepinnten PptxGenJS-Releases importiert fuer Node-Laufzeiten
aber ausdruecklich das eingebaute Modul `node:https`; fuer Browser-Bundles
werden sowohl `https` als auch `node:https` auf `false` gemappt. Das npm-Paket
wirkt deshalb technisch ueberfluessig, bleibt bis zu einer Upstream-Korrektur
aber Bestandteil des reproduzierbaren Dependency-Graphen.

Technische Entscheidung:

- Tarball, Integrity, Registry-Signatur, ISC-Deklaration, Inhalt und transitive
  Herkunft sind dokumentiert.
- Canvas erfindet weder einen ISC-Text mit eingesetzten Platzhaltern noch
  einen Copyright-Inhaber.
- Der Audit entfernt oder ersetzt die transitive Abhaengigkeit nicht still im
  Lockfile; das waere eine eigene getestete Dependency-Aenderung.
- Der Blocker kann durch eine korrigierte PptxGenJS-Version, einen belastbaren
  Lizenzbeleg des Paket-Publishers, Entfernung/Ersatz oder eine dokumentierte
  menschlich-rechtliche Einzelfallentscheidung aufgeloest werden.
