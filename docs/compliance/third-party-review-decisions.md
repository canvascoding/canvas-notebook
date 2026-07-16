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
