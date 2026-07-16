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
