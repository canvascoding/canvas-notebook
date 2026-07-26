# sharp/libvips Native Binary Review

Stand: 2026-07-26

## Abschlussupdate: Ausschluss der vorgebauten Archive

Die 28 unvollstaendig belegten `@img/sharp-libvips-*`,
`@img/sharp-win32-*` und `@img/sharp-wasm32` bleiben im Gesamtinventar
sichtbar und `review_required`. Sie blockieren Canvas-Releases aber nicht
mehr, weil sie nicht mehr von Canvas ausgeliefert werden:

- Alle 52 optionalen `@img/sharp-*`-Lockfile-Positionen sind als
  `source-development-install` klassifiziert. Ein Lockfile-Verweis ist kein
  von Canvas gebuendeltes Binaerartefakt; ein Source-Nutzer laedt optionale
  Pakete unmittelbar von npm.
- Der Docker-Build entfernt nach `npm ci` und erneut nach dem
  Production-Prune jedes installierte `@img/sharp-*`-Verzeichnis.
- Das Runtime-Inventar muss deshalb fuer beide Linux-Plattformen eine leere
  Liste `installedSharpPrebuiltPackages` liefern.

Canvas baut stattdessen libvips 8.18.3 als Shared Library aus dem offiziellen
Release-Archiv
`https://github.com/libvips/libvips/releases/download/v8.18.3/vips-8.18.3.tar.xz`
mit SHA-256
`f41285b61bfb495605494f074ca341f7791a1d406e2f157dcea606ef1ae1b146`.
Das Archiv bleibt unveraendert, wird im Image unter
`/usr/share/canvas-notebook/corresponding-source/` mitgeliefert und zusammen
mit LGPL-2.1-or-later, Dockerfile und Austauschanleitung in das native
Release-Evidenzarchiv aufgenommen.

Sharp 0.35.3 und die von Next.js verwendete Version 0.35.2 werden beide lokal
gegen `/usr/local/lib/libvips*.so*` gebaut. Je Plattform muss CI:

1. beide lokalen `.node`-Addons samt Hash inventarisieren,
2. per `ldd` die dynamische Aufloesung nach `/usr/local/lib` belegen,
3. mit beiden Sharp-Versionen ein echtes SVG als PNG konvertieren,
4. Abwesenheit aller vorgebauten `@img/sharp-*`-Pakete nachweisen,
5. den libvips-Source-Hash und alle Evidenzen vor dem Multi-Arch-Manifest
   zwischen amd64 und arm64 vergleichen.

Der Austauschweg, `ldconfig`-Schritt und die betriebliche Upgrade-Folge stehen
in `sharp-libvips-relinking.md`. Canvas verbietet fuer diesen LGPL-Anteil
keine zur Modifikation oder zum Debugging erforderliche Reverse-Engineering-
Handlung. Die technische Aufloesung gilt nur fuer die Docker-Lieferung;
zukuenftige Electron-/Windows-/WASM-Artefakte duerfen die vorgebauten Archive
nicht ohne eine neue, artefaktbezogene Pruefung aufnehmen.

## Historische Entscheidung zu den Upstream-Binaerarchiven

Die 28 plattform- und versionsspezifischen `sharp`-/`libvips`-Positionen
bleiben `review_required` und blockieren ein kommerzielles Release. Sie sind
nicht als unzulaessig bewertet. Die derzeit veroeffentlichten npm-Archive
reichen aber allein nicht aus, um die Pflichten der enthaltenen Bibliotheken
reproduzierbar zu erfuellen.

Diese Entscheidung darf erst auf `allowed` geaendert werden, wenn fuer jedes
tatsaechlich ausgelieferte Plattformartefakt:

1. alle eingebauten Bibliotheken samt vollstaendigen Lizenz- und
   Copyright-Hinweisen erfasst sind,
2. GPLv3 und LGPLv3 zusammen mit dem Objektcode ausgeliefert werden,
3. der vollstaendige Corresponding Source einschliesslich Build-Skripten und
   angewandten Patches zeitgleich und dauerhaft erreichbar ist,
4. Austausch beziehungsweise Relinking und die dafuer erforderliche
   Installation dokumentiert und getestet sind,
5. die Produktbedingungen Reverse Engineering zum Debuggen von
   LGPL-Modifikationen nicht untersagen,
6. ein benannter verantwortlicher oder rechtlicher Reviewer die konkrete
   Plattform- und Distributionsform freigibt.

Eine URL auf den aktuellen Upstream-Branch, ein SPDX-Kuerzel oder nur die
Apache-2.0-Datei aus dem npm-Archiv erfuellt diese Checkliste nicht.

Die erneute Pruefung am 17. Juli 2026 hat diese Entscheidung bestaetigt:

- die offizielle LGPLv3 verlangt fuer Combined Works entweder Minimal
  Corresponding Source und geeigneten Application Code zum Relinking oder
  einen nachweislich geeigneten Shared-Library-Mechanismus sowie
  Installationsinformationen,
- die offizielle sharp-Dokumentation bestaetigt, dass die vorgebauten
  Plattformbinaries verwendet werden und ein eigenes globales libvips nur
  unter den dokumentierten Plattform- und Versionsbedingungen greift,
- die exakten `sharp-libvips`-Builddefinitionen bestaetigen weiterhin die
  Vielzahl statisch eingebauter Bibliotheken.

Primaerquellen:

- `https://www.gnu.org/licenses/lgpl+gpl-3.0-standalone.html`
- `https://sharp.pixelplumbing.com/install/`
- `https://github.com/lovell/sharp-libvips/tree/6d80db40e9f37e311c13d1149745fcd80b5466db`
- `https://github.com/lovell/sharp-libvips/tree/4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6`

Die verantwortliche Erstfreigabe des Gesamtinventars ist dokumentiert. Sie
setzt diese Bedingungen nicht ausser Kraft; die 28 Eintraege bleiben deshalb
weiterhin harte Artefaktblocker.

## Exakter Bestand

Der Lockfile-Bestand umfasst zwei getrennte `sharp`-Linien:

| Verwendung | sharp | sharp Source-Commit | sharp-libvips | sharp-libvips Source-Commit | libvips |
| --- | --- | --- | --- | --- | --- |
| direkte Canvas-Abhaengigkeit | 0.35.3 | `1018449164723ba0203c1beffaba0e21f7829c18` | 1.3.2 | `4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6` | 8.18.3 |
| Next.js optional | 0.35.2 | `c9622a38edfc6fc709764152ea34332ba01619cf` | 1.3.1 | `6d80db40e9f37e311c13d1149745fcd80b5466db` | 8.18.3 |

Die 28 Reviewpositionen bestehen aus:

| Familie | Plattformen | Versionen | Anzahl | npm-Deklaration |
| --- | --- | --- | ---: | --- |
| `@img/sharp-libvips-*` | darwin-arm64, darwin-x64, linux-arm, linux-arm64, linux-ppc64, linux-riscv64, linux-s390x, linux-x64, linuxmusl-arm64, linuxmusl-x64 | 1.3.1, 1.3.2 | 20 | `LGPL-3.0-or-later` |
| `@img/sharp-win32-*` | arm64, ia32, x64 | 0.35.2, 0.35.3 | 6 | `Apache-2.0 AND LGPL-3.0-or-later` |
| `@img/sharp-wasm32` | wasm32 | 0.35.2, 0.35.3 | 2 | `Apache-2.0 AND LGPL-3.0-or-later AND MIT` |

Paketpfad, Version, signierte npm-Integritaet und Tarball-URL stehen
versionsgenau in `package-lock.json`. Der Lizenzcache bindet jeden dieser
Pfade an den veroeffentlichten 40-stelligen Source-Commit. Ein Release darf
nur die auf seiner Zielplattform tatsaechlich installierten Binaerpakete
ausliefern; die uebrigen optionalen Lockfile-Positionen bleiben trotzdem im
Gesamtinventar sichtbar.

## Reproduzierte Archivbefunde

Stichproben wurden fuer beide Versionslinien aus den exakten, im Lockfile
gepinnten npm-Tarballs vorgenommen.

### POSIX- und macOS-libvips-Pakete

Die Linux-x64-Archive enthalten:

- `README.md`,
- `package.json`,
- `versions.json`,
- `libvips-cpp.so.8.18.3`,
- aber keine `LICENSE`-, `COPYING`- oder vollstaendige Notice-Datei.

Die README nennt die Bibliotheksfamilien und ihre Kurzlizenzen. Der
Repository-Root von `sharp-libvips` enthaelt eine Apache-2.0-Lizenz fuer die
Build- und Verpackungsskripte. Diese Datei ist nicht der LGPL-Text fuer
`libvips` und wurde deshalb als Paketlizenzbeleg verworfen. Der vorherige
Cache hat diese beiden Ebenen faelschlich gleichgesetzt; Schema 5 behebt
diesen Fehler und verhindert die automatische Wiederholung.

Die POSIX-Buildskripte kompilieren zahlreiche Abhaengigkeiten statisch in die
ausgelieferte dynamische `libvips-cpp`-Bibliothek. Darunter befinden sich je
nach Version unter anderem:

- aom, cairo, cgif, expat, fontconfig, freetype, fribidi, glib, harfbuzz,
  highway, lcms, libarchive, libexif, libffi, libheif, libimagequant,
  libnsgif, libpng, librsvg, libspng, libtiff, libvips, libwebp, libxml2,
  mozjpeg, pango, pixman, proxy-libintl und zlib-ng,
- in 1.3.2 zusaetzlich libultrahdr.

Damit muss ein Source-/Notice-Artefakt mehr als nur den `libvips`-Quellbaum
enthalten. Es muss die exakten Quellstaende, Buildskripte und alle von
`sharp-libvips` angewandten Patches des konkreten Binaries abbilden.

### Windows-Pakete

Die Windows-x64-Archive enthalten neben dem nativen `sharp`-Addon
`libvips-42.dll` und `libvips-cpp-8.18.3.dll`. Ihre `LICENSE`-Datei enthaelt
nur Apache-2.0 fuer
`sharp`. Die README nennt zwar die eingebauten Drittbibliotheken, liefert
aber weder LGPL/GPL noch deren vollstaendige Einzeltexte.

Die getrennten DLLs sprechen technisch fuer einen austauschbaren
Shared-Library-Mechanismus. Vor einer Freigabe muss ein Zwei-Binary-Test
nachweisen, dass Canvas mit einer modifizierten, interface-kompatiblen
`libvips`-DLL laeuft, und die Installation des Ersatzes muss dokumentiert
werden. Das Ergebnis darf nicht allein aus der Dateistruktur abgeleitet
werden.

### WebAssembly-Pakete

Die WASM-Archive enthalten ein kombiniertes `.wasm`-Modul und den
JavaScript-Loader. Auch hier deckt `LICENSE` nur Apache-2.0 fuer `sharp` ab;
die README nennt unter anderem LGPL-Bibliotheken, Emscripten und weitere
permissiv lizenzierte Bestandteile.

Fuer das kombinierte WASM-Modul ist kein belastbarer dynamischer
Austauschmechanismus nachgewiesen. Eine kommerzielle Auslieferung bleibt
deshalb gesperrt, bis entweder geeigneter Relinking-/Application-Code samt
Installationsweg bereitsteht oder das WASM-Paket nachweislich aus allen
Canvas-Lieferartefakten ausgeschlossen wird.

## Rechtliche und technische Mindestanforderungen

LGPLv3 ist eine Ergaenzung zur GPLv3. Fuer ein Combined Work verlangt sie
insbesondere einen deutlichen Nutzungshinweis, GPL- und LGPL-Text,
wirksame Erlaubnis zur Modifikation und zum Reverse Engineering fuer das
Debugging sowie entweder geeignete Relinking-Unterlagen oder einen
funktionierenden Shared-Library-Mechanismus.

Fuer die LGPL-Bibliothek als Objektcode gelten ausserdem die
Corresponding-Source-Regeln der GPLv3. Bei einem Netzwerkdownload muss der
Source gleichwertig und ohne Mehrkosten angeboten werden. Er darf auf einem
anderen Server liegen, wenn direkt beim Objektcode klar darauf verwiesen
wird; Canvas bleibt fuer die dauerhafte Verfuegbarkeit verantwortlich.

Fuer Canvas folgt daraus:

- Ein GitHub-Link auf einen fremden Branch ist kein dauerhaft kontrollierter
  Source-Nachweis.
- Der exakte Upstream-Tag allein genuegt nicht, wenn das Binary statisch
  eingebettete Abhaengigkeiten und angewandte Patches enthaelt.
- Der Source-Bundle-Hash muss an Release, Plattform, npm-Integritaet und
  Binary-Hash gebunden werden.
- Docker-Registry, GitHub Release, Electron-Download und CLI-Download
  brauchen jeweils einen klaren benachbarten Source-Link.
- Die Produkt-EULA beziehungsweise Sustainable-Use-Lizenz muss fuer diese
  Drittbestandteile ausdruecklich hinter LGPL/GPL zuruecktreten.

## Freigabepfad

Der bevorzugte technische Freigabepfad ist:

1. Pro tatsaechlich gebauter Plattform den finalen Paketinhalt erfassen und
   nicht installierte optionale Plattformpakete aus dem Lieferartefakt
   ausschliessen.
2. Aus den exakten `sharp-libvips`-Builddefinitionen ein reproduzierbares
   Source-Bundle mit allen Quellarchiven, Patches, Build- und
   Installationsskripten erzeugen.
3. Alle enthaltenen Lizenz- und Copyright-Texte aus diesem Bundle in die
   Canvas-Notices uebernehmen.
4. POSIX/macOS/Windows mit einer modifizierten interface-kompatiblen
   Shared Library testen und den Austauschweg dokumentieren.
5. WASM entweder mit belastbarem Relinking-Modell separat freigeben oder
   vollstaendig aus den Releaseartefakten entfernen.
6. Source-Bundle und Hashmanifest im Release-Workflow neben den jeweiligen
   Objektartefakten publizieren und per Artefakttest pruefen.
7. Erst danach die 28 Eintraege mit Reviewer, Datum und Plattformbezug
   versionsgenau freigeben.

Bis diese Schritte implementiert und menschlich abgenommen sind, ist
`npm run test:licenses:release` absichtlich rot.
