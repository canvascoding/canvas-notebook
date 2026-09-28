# Docker Runtime License Review

Stand: 2026-07-17

## Kandidat mit lokaler Diktatfunktion (2026-09-28)

Der Merge von `main` erweitert `requirements/runtime-python.txt` fuer
Faster-Whisper von 45 auf 58 per pip installierte Pakete. Der alte
Schema-4-Image-Nachweis fuer `v2026.7.17.5` gilt weiterhin nur fuer dessen
45-Paket-Lock und ist keine Freigabe dieses Kandidaten. Der neue Lock hat SHA-256
`c7f508dc3b17741b74e76911182003a95439187f25985313323d40dcef521533`.

Die folgenden 13 neuen Pakete wurden jeweils anhand der exakten
[PyPI-Versionsmetadaten](https://pypi.org/) geprueft. Saemtliche 105 im Lock
aufgefuehrten neuen SHA-256-Dateihashes stimmen mit den Dateien derselben
PyPI-Version ueberein; es gab keinen unbekannten Hash. Die Lizenzspalte gibt
die dortige SPDX-Expression oder, wenn sie fehlt, die PyPI-Klassifikation an.

| Paket | Version | Lock-Hashes | PyPI-Lizenzmetadaten |
| --- | --- | ---: | --- |
| [anyio](https://pypi.org/project/anyio/4.15.1/) | 4.15.1 | 2 | MIT |
| [av](https://pypi.org/project/av/18.1.0/) | 18.1.0 | 19 | BSD-3-Clause |
| [ctranslate2](https://pypi.org/project/ctranslate2/4.8.2/) | 4.8.2 | 35 | MIT |
| [faster-whisper](https://pypi.org/project/faster-whisper/1.2.1/) | 1.2.1 | 1 | MIT |
| [filelock](https://pypi.org/project/filelock/4.0.5/) | 4.0.5 | 2 | MIT |
| [fsspec](https://pypi.org/project/fsspec/2026.9.0/) | 2026.9.0 | 2 | BSD-3-Clause |
| [h11](https://pypi.org/project/h11/0.16.0/) | 0.16.0 | 2 | MIT |
| [hf-xet](https://pypi.org/project/hf-xet/1.6.0/) | 1.6.0 | 17 | Apache-2.0 |
| [httpcore](https://pypi.org/project/httpcore/1.0.9/) | 1.0.9 | 2 | BSD-3-Clause |
| [httpx](https://pypi.org/project/httpx/0.28.1/) | 0.28.1 | 2 | BSD-3-Clause |
| [huggingface-hub](https://pypi.org/project/huggingface-hub/1.33.0/) | 1.33.0 | 2 | Apache-2.0 |
| [tokenizers](https://pypi.org/project/tokenizers/0.23.2/) | 0.23.2 | 17 | Apache-2.0 (Klassifikation) |
| [tqdm](https://pypi.org/project/tqdm/4.70.1/) | 4.70.1 | 2 | MPL-2.0 AND MIT (Freitext; gesonderte Lizenzentscheidung erforderlich) |

Die Hashpruefung und der statische `test:licenses`-Gate bestaetigen
Reproduzierbarkeit und bekannte Bezugsdateien, aber ersetzen weder das
Image-Inventar noch die Freigabe der neuen Runtime-Lizenzen. Insbesondere
`tqdm` faellt wegen der kombinierten MPL-/MIT-Angabe nicht unter die alte
MIT-Standardentscheidung. Vor einer neuen Image-Veroeffentlichung sind die
beiden Plattform-Inventare, deren Lizenzdateien und der Release-Gate erneut zu
pruefen und die versionsgenaue Owner-Entscheidung festzuhalten.

Der erste isolierte arm64-Image-Build zeigte ausserdem, dass `av@18.1.0`
Python-Bytecode unter `.dist-info/licenses/__pycache__` mitliefert. Der
Collector verwirft jetzt nur Cache-/Bytecode-Pfade und behaelt die echten
PEP-639-Texte; eine synthetische PyAV-Fixture und der Image-Build pruefen
diese Grenze. Der naechste Image-Gate fand bei `tokenizers@0.23.2` weder
Lizenz-Metadaten noch einen Lizenztext im Python-Wheel. Das exakte
[PyPI-sdist](https://pypi.org/project/tokenizers/0.23.2/#files) mit SHA-256
`7f0f085686b9de0d0079e6f874ae053600db64c5d13049e0bbc0119926d25aac`
enthaelt `tokenizers/LICENSE`. Dessen SHA-256
`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`
ist byte-identisch zum Root-`LICENSE` am offiziellen
[Tag `v0.23.2`](https://github.com/huggingface/tokenizers/releases/tag/v0.23.2)
(`88a4498ad4ea1a9487b0a9b0ff881383fd5a06a3`); das zugehoerige
`tokenizers/Cargo.toml` nennt Version 0.23.2 und Apache-2.0. Der Text ist
separat in den Notices und im Image enthalten, und der Runtime-Test bindet
ihn an Version, Commit und Dateihash. Eine blosse PyPI-Klassifikation reicht
dafuer nicht aus.

Das [PyPI-sdist fuer `tqdm@4.70.1`](https://pypi.org/project/tqdm/4.70.1/#files)
hat SHA-256 `cefd0eca11b2a37a3aee776544d4f4ae913f02688135b5556b8788dfa474afc4`.
Sein `LICENCE`-Text ist mit dem offiziellen Tag `v4.70.1`
(`9cf5a12b1f955468a17f0ba3c59092b23e4258ac`) byte-identisch
(SHA-256 `fcff87c3a47ce8028a8512aa182d4fcf0ad1c90544ee75cf9b343684cac194de`)
und wird ebenfalls in die Notices aufgenommen. Die Policy markiert diesen
Eintrag `review_required` und die Freigabe des gesamten neuen Image-Kandidaten
`pending`; die Freigabe vom Juli bleibt nur historisch gueltig. Der statische
Release-Gate muss deshalb blockieren, bis der Owner die neuen nativen
Abhaengigkeiten und MPL-/MIT-Bedingungen bewertet hat.

Ein `pip download --require-hashes --only-binary=:all:` mit CPython 3.11 und
`manylinux_2_28`/`manylinux2014` fuer x86_64 waehlt genau 58 Wheels und
akzeptiert deren Lock-Hashes. Die bereits vorher enthaltene Version
`pypdfium2@5.12.0` ist auf PyPI inzwischen als yanked markiert; pip nennt
als Grund einen Setup-Fehler in einigen Bindgen-Pfaden und bezeichnet die
Wheels als effektiv identisch zu 5.12.1. Das aendert keine Lizenzentscheidung
dieses Diktat-Merges, muss aber vor einem neuen Release bewusst geprueft werden.

Ein isolierter lokaler arm64-Docker-Build des Kandidaten (Image-ID
`sha256:9aeab5c353db702dde9ef4fbb13c767a65671b11ff1d1f5079e683dc1ddb771b`)
bestand den fokussierten PEP-639-Test, den vollstaendigen Runtime-Inventartest
und den Sharp-Linkage-Test. Das aus dem gestoppten Image entnommene Inventar
enthaelt 509 Debian-Pakete, 61 Python-Distributionen (58 pip- und drei
Debian-verwaltete) sowie 153 globale npm-Pakete. Sein Python-Lock-Hash stimmt
mit der obigen Datei ueberein. Fuer `av@18.1.0` blieben drei echte
Lizenzdateien und kein Bytecode als Beleg; `tokenizers@0.23.2` hat weiterhin
null Wheel-eigene Belege und wird nur durch die versionierte externe
Apache-2.0-Evidenz akzeptiert; `tqdm@4.70.1` hat einen Wheel-eigenen Beleg
und die separate gebundene `LICENCE`-Kopie. Das Image wurde weder gestartet
noch fuer den vorhandenen lokalen Vier-Dienste-Teststack eingesetzt. Ein
finales amd64-Image-Inventar und die Owner-Freigabe stehen noch aus.

## Abschlussupdate fuer Schema 4

Der zuvor blockierende Sammelposten `node-docker-base` ist fuer den exakt
definierten Lieferweg `allowed`. Das ist keine pauschale Lizenzierung aller
Containerinhalte, sondern eine kontrollierte Aggregate-Entscheidung des
verantwortlichen Owners mit weiterhin komponentengenauen Belegen.

Die neue Definition bindet den Lieferumfang an:

- `node:24-bookworm-slim` unter dem unveraenderlichen Multi-Arch-Digest
  `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`,
- Debian Bookworm und Security unter Snapshot `20260716T000000Z`, jeweils mit
  `deb` und `deb-src`,
- PostgreSQL 18.4 und `postgresql-client-common` 293 aus PGDG mit exakten
  amd64-/arm64-Binary-Hashes und den exakten `.dsc`-/Source-Archiv-Hashes,
- 45 pip-Pakete mit einer gemeinsamen, versions- und wheel-gehashten
  Python-3.11-Lockdatei fuer linux/amd64 und linux/arm64,
- ein Schema-4-Runtime-Inventar mit Dockerfile-/Policy-/Lock-Hash, Node,
  libvips, dpkg-Binary-zu-Source-Zuordnung, Python, globalem npm und den lokal
  gebauten Sharp-Addons.

Der Tag-Workflow prueft die finalen Plattformimages getrennt und danach
gemeinsam. Das Multi-Arch-Manifest wird erst erzeugt, wenn beide Inventare,
Notices, Hauptinventare, libvips-Quellarchive und Sharp-Linkage-Evidenzen
erfolgreich verglichen wurden. Die Evidenzen werden als
`canvas-native-compliance-<version>.tar.gz` aufbewahrt. Exakte Parameter und
Hashes stehen in `docker-native-distribution-policy.json`.

Das minimale Node-Basisimage besitzt anfangs keinen CA-Store. Deshalb wird
`ca-certificates` einmal ueber HTTP aus genau demselben, APT-signierten
Snapshot installiert; danach werden die unveraenderten Snapshot-Quellen auf
HTTPS umgestellt. Der libvips-Laufzeitstage installiert nur die expliziten
Codec-/GLib-/Pango-Laufzeitbibliotheken. Das Debian-Paket `libvips42` wird
nicht zusaetzlich ausgeliefert, sodass `/usr/local/lib/libvips*.so*` eindeutig
aus dem gehashten Canvas-Source-Build stammt. Die korrespondierenden
Development-Header werden ausschliesslich im isolierten `deps`-Stage fuer den
Build beider Sharp-Versionen installiert und nicht in das Runtime-Image
uebernommen.

Der Remote-Lauf `29569016479` fuer `v2026.7.17.3` bestaetigte den korrigierten
Snapshot-/CA- und libvips-Source-Build auf amd64 und arm64, stoppte danach aber
vor jeder Veroeffentlichung beim Sharp-Compile, weil dem `deps`-Stage die
transitiven libvips-Development-Header fehlten. `v2026.7.17.4` nahm genau
diese nur in den Build-Stage auf.

Der Folgelauf `29570228102` fuer `v2026.7.17.4` baute und pruefte beide
Architekturimages samt Sharp-Linkage erfolgreich. Der gemeinsame Vergleich
blockierte die Veroeffentlichung anschliessend korrekt, weil der Python-
Collector Dateien unter dem Python-Modulpfad `packaging/licenses/` inklusive
architekturspezifischer `.pyc`-Dateien faelschlich als Lizenztexte einstufte.
Ab `v2026.7.17.5` gelten fuer PEP-639-Verzeichnisse nur Pfade innerhalb von
`.dist-info/licenses`; echte Lizenztexte und ihre Hashes bleiben Teil des
plattformuebergreifenden Vergleichs.

Der abschliessende Tag-Workflow `29571886433` fuer `v2026.7.17.5` ist auf dem
unveraenderlichen Commit `0be9b703e34155472378806339672a51e59169f6`
vollstaendig erfolgreich. Er baute und pruefte beide finalen Plattformimages,
verglich Notices, Hauptinventar, libvips-Quellarchiv, Python-Lizenzdateien und
Sharp-Linkage und veroeffentlichte erst danach den Multi-Arch-Digest
`sha256:7cb8d2c02ec08369925d54d1f669bc22fb4f5e9040193df385d35292da2198e2`
auf GHCR und Docker Hub. Das amd64-Inventar enthaelt 418 Debian-Binaries aus
283 Source-Paaren, das arm64-Inventar 414 aus 281; beide enthalten jeweils 48
Python- und 153 globale npm-Pakete. Die beiden Sharp-Versionen sind gegen die
gemeinsam ausgelieferte libvips-Shared-Library 8.18.3 verlinkt; vorgebaute
`@img/sharp-*`-Pakete sind auf beiden Plattformen leer.

Die Release-Evidenz `canvas-native-compliance-2026.7.17.5.tar.gz` ist im
GitHub Release veroeffentlicht. Ihre mitgelieferte SHA-256-Datei wurde nach dem
Download erfolgreich geprueft. Die drei `packaging@26.2`-Lizenzdateien liegen
auf beiden Plattformen ausschliesslich unter `.dist-info/licenses`, sind
byte-identisch und enthalten keine `.pyc`- oder `__pycache__`-Fehlbelege. Der
Control-Plane-Webhook akzeptierte denselben Commit, Tag und Image-Digest.

Der lokale Arbeitslauf vom 17. Juli 2026 hat auf ausdrueckliche Owner-Vorgabe
keinen Container gebaut. Die notwendige reale Container- und
Multi-Arch-Pruefung erfolgte stattdessen vollstaendig im taggebundenen
Remote-Workflow.

Ohne Containerbau wurden alle in der Policy referenzierten PGDG-Binaer- und
Source-URLs erneut heruntergeladen und gegen ihre zehn hinterlegten SHA-256-
Werte geprueft. Die Python-Lockdatei wurde mit pip-Dry-Runs fuer CPython 3.11
gegen die kompatiblen `manylinux_2_28`-/`manylinux2014`-Tags auf amd64 und
arm64 aufgeloest; beide Plattformen waehlen exakt denselben 45-Paket-Bestand
und akzeptieren die hinterlegten Wheel-Hashes.

Bei jeder Aenderung an Basisdigest, Snapshot, apt-/PGDG-Paketen, Python-Lock,
Dockerfile oder Plattformmatrix erlischt diese konkrete technische Zuordnung
und muss durch neue Artefakte ersetzt werden. Die unter
`/usr/share/doc/*/copyright` enthaltenen komponentenspezifischen Bedingungen
bleiben vorrangig; Source-Paket und Version werden im Release-Inventar exakt
auf den Debian-Snapshot beziehungsweise die gehashten PGDG-Quellen abgebildet.

## Historischer Schema-3-Ausgangsbefund

Der Docker-Lieferumfang ist technisch inventarisiert, aber noch nicht fuer
ein kommerzielles Release freigegeben. Der Sammelposten `node-docker-base`
bleibt `review_required`. Die drei zuvor offenen Pakete des global
installierten npm sind seit dem 17. Juli 2026 fuer ihre exakten Versionen durch
eine benannte verantwortliche Restrisikoentscheidung `allowed`.

Der aktuelle Scan erfasst jetzt vier statt bisher nur zwei Runtime-Klassen:

| Klasse | aktueller Linux-arm64-Testbestand | Nachweis |
| --- | ---: | --- |
| Node-Runtime | 1 | Version, Source-Tag und Hash von `/usr/local/LICENSE` |
| Debian-Binaerpakete | 408 aus 276 Source-Paket/Versionspaaren | Binary-Version, Source-Paket, Source-Version und Hash von `/usr/share/doc/*/copyright` |
| Python-Distributionen | 48, davon 45 durch pip und 3 durch Debian | Metadaten, Installer, RECORD-Hash und 94 erkannte Lizenzdateien |
| globales npm | 153 Pakete | Version, Source-URL, deklarierte Lizenz und 147 Paket-Lizenzdateien |

Die Zahlen stammen aus dem innerhalb des Dockerfiles erzeugten Schema-3-
Inventar des am 16. Juli 2026 isoliert neu gebauten Linux-arm64-Images
`sha256:d8a3666463040b15e03688e32807fd4ff656a7430ee37532e98f3423b1081409`.
Das erzeugte `/app/docs/compliance/runtime-components.json` wurde aus dem
gestoppten Image gelesen und erneut geprueft; sein SHA-256 ist
`80b985ec9a8e7c5d0a58923fbfbf481df465eddf7fbecf2e0203b2a5d242f078`.
Host und Image enthalten ausserdem byte-identische Notices
(`0ecd5fd6b596b508d69a7ccdb7d86f0c62de972648aa24d8fd5e88ef590fa1be`)
und Hauptinventare
(`4123331991546758187cf86451641fbd92c9f2642fe75b70d69750f5e19d292a`).
Der bestehende App-Container wurde fuer diesen Audit nicht ersetzt.

## Basisimage und Plattformbindung

Das Dockerfile verwendet den unveraenderlichen Multi-Architecture-Index:

`node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`

Der Index enthaelt fuer die von Canvas gebauten Hauptplattformen:

| Plattform | Manifest-Digest |
| --- | --- |
| linux/amd64 | `sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6` |
| linux/arm64/v8 | `sha256:af01d58b748ec92b1d6e8e11429aad424fd1e68c848185399dca0596a1ab8f5c` |

Das Runtime-Inventar speichert ab Schema 3 neben dem Index auch
`TARGETPLATFORM`. `linux/arm64` ist durch den obigen Image-Build verifiziert;
`linux/amd64` bleibt fuer eine spaetere plattformuebergreifende Freigabe
offen. Eine Freigabe gilt nur fuer ein tatsaechlich gebautes und geprueftes
Plattformmanifest; sie darf nicht pauschal auf alle Eintraege des
Multi-Architecture-Index uebertragen werden.

Der Node-Lieferumfang liegt ausserhalb von dpkg. Er wird deshalb als eigene
Native-Komponente mit Version `24.18.0`, Source-Tag und der aggregierten
Node-Lizenz unter `/usr/local/LICENSE` erfasst.

## Debian-Pakete

Alle 408 Binaerpakete des geprueften arm64-Images besitzen eine lesbare und
gehashte Debian-Copyright-Datei. Der alte Scan dokumentierte nur Binary-Name
und -Version. Schema 3 erfasst zusaetzlich die Felder
`${source:Package}` und `${source:Version}` aus dpkg. Dadurch werden die 408
Binaerpakete auf 276 konkrete Source-Paket/Versionspaare abgebildet.

Das ist eine notwendige Grundlage, aber noch kein fertiges
Corresponding-Source-Angebot. Vor Freigabe muss der Release-Workflow:

1. alle Source-Paket/Versionspaare aus dem finalen amd64- und arm64-Image
   exportieren,
2. die exakten Debian- und PostgreSQL-PGDG-Source-Artefakte samt Checksummen
   herunterladen oder in einem von Canvas kontrollierten dauerhaften Mirror
   sichern,
3. direkt bei jedem Container-Download auf das passende Source-Manifest
   verweisen,
4. GPL/LGPL- und sonstige Copyleft-Pflichten aus den Debian-Copyright-Dateien
   gegen die konkrete Binaerauslieferung pruefen.

Die blossen Binary-Copyright-Dateien ersetzen den Corresponding Source nicht.
Da apt-Pakete im Dockerfile nicht versionsgepinnt sind, ist dieser Abgleich
nach jedem Neuaufbau erforderlich.

## Python-Pakete

Der vorherige Scanner erkannte nur Dateien, deren Dateiname mit
`LICENSE`, `COPYING`, `COPYRIGHT` oder `NOTICE` beginnt. PEP 639 legt Texte
haeufig unter einem Verzeichnis `licenses/` ab. Dadurch wurden insbesondere
die vollstaendigen PDFium-Build-Lizenzen von `pypdfium2` uebersehen.

Schema 3 erkennt nun auch `license/`, `licenses/`, `licence/` und
`licences/` als Pfadsegmente. Im geprueften Bestand steigen die gefundenen
Python-Lizenzdateien dadurch auf 94. `pypdfium2@5.12.0` wird mit Apache-,
BSD-, CC-BY- und allen plattformspezifischen PDFium-
Drittbibliothekstexten erfasst.

Drei pip-Wheels liefern trotz Lizenzdeklaration keinen Text mit. Sie sind
versionsgenau als Non-npm-Komponenten im Hauptinventar ergaenzt:

| Paket | Entscheidung | Primaerbeleg |
| --- | --- | --- |
| `flatbuffers@25.12.19` | `allowed`, Apache-2.0 | signierter Tag, Commit `7e163021e59cca4f8e1e35a7c828b5c6b7915953`, exakter Upstream-Text und Google-Header |
| `magika@0.6.3` | `allowed`, Apache-2.0 | PyPI-sdist SHA-256 `7cc52aa7359af861957043e2bf7265ed4741067251c104532765cd668c0c0cb1`, Tag-Commit `a04562a9bb5d52c809a4424911ca8d07c0265767` und Google-Header |
| `markitdown@0.1.6` | `allowed`, MIT | PyPI-sdist SHA-256 `e5bdbaffd971b29598c7c39ef0e9afce2f08c0751fbfa4e4257678ebaf8cfc7e`, signierter Tag-Commit `e144e0a2be95b34df17433bac904e635f2c5e551` und Microsoft-Copyright |

Die drei durch Debian verwalteten Python-Pakete werden ueber ihre dpkg-
Source- und Copyright-Nachweise abgedeckt. Fuer pip-Wheels speichert der
Scanner zusaetzlich den Hash der installierten `RECORD`-Datei. Bei nativen
Wheels muss der spaetere Source-Workflow auch deren eingebettete Bibliotheken
beruecksichtigen; ein PyPI-Projektlink allein genuegt nicht.

Alle pip-Pakete werden derzeit ohne Versionspins installiert. Das ist fuer
einen reproduzierbaren kommerziellen Release unzureichend. Entweder muessen
Versionen und Wheel-Hashes vor dem Build gepinnt werden oder der
post-build erzeugte exakte Bestand muss vor jeder Veroeffentlichung neu
geprueft und samt Quellen gesichert werden. Der bevorzugte Weg ist eine
plattformbezogene Hash-Lockdatei.

## Global installiertes npm

`npm@11.11.0` wird im finalen Image global installiert und bringt 152
weitere Pakete neben npm selbst mit. Diese Komponenten liegen nicht im
Canvas-`package-lock.json` und fehlten deshalb bislang im Hauptinventar.

Schema 3 laeuft rekursiv durch `/usr/local/lib/node_modules`, erfasst 153
Paketpfade und verifiziert 147 vorhandene Paket-Lizenzdateien. Die sechs
Paketpfade ohne eigenen Text wurden einzeln geprueft:

| Paket | Ergebnis |
| --- | --- |
| `@sigstore/verify@3.1.0` | Apache-2.0 anhand npm-`gitHead`, exaktem Monorepo-Commit und Sigstore-Copyright ergaenzt; `allowed` |
| `imurmurhash@0.1.4` | identische bereits inventarisierte MIT-Version, Tag und Copyright; `allowed` |
| `spdx-license-ids@3.0.23` | exakter CC0-Datensatz mit offiziellem CC0-1.0-Legal-Code; `allowed` |
| `@npmcli/agent@4.0.0` | ISC nur deklariert; fehlender Upstream-Text und unvollstaendige Attribution als versionsgebundenes Restrisiko akzeptiert; kanonischer ISC-Text und Best-Evidence-Attribution werden ausgeliefert; `allowed` |
| `err-code@2.0.3` | README verlinkt generische MIT-Bedingungen; fehlender Upstream-Volltext und Rechteinhaberzeile als versionsgebundenes Restrisiko akzeptiert; kanonischer MIT-Text und Best-Evidence-Attribution werden ausgeliefert; `allowed` |
| `spdx-exceptions@2.5.0` | CC-BY-3.0 deklariert; fehlender Legal-Code und unvollstaendige Attribution im Tarball als versionsgebundenes Restrisiko akzeptiert; offizieller CC-BY-3.0-Text und Best-Evidence-Attribution werden ausgeliefert; `allowed` |

Die letzten drei Pakete werden nicht durch die Sammellizenz von npm geheilt.
Frank Alexander Weber hat deshalb fuer die exakten Versionen eine
verantwortliche Einzelfallentscheidung getroffen. Canvas liefert die
kanonischen beziehungsweise offiziellen Lizenztexte und folgende
bestverfuegbare Publisher-Attributionen aus:

- `@npmcli/agent@4.0.0`: GitHub, Inc. und Contributors,
- `err-code@2.0.3`: IndigoUnited und Contributors,
- `spdx-exceptions@2.5.0`: The Linux Foundation; Package-Contribution von
  Kyle E. Mitchell.

Die Unsicherheit der fehlenden Upstream-Notices bleibt im Freigabebeleg
ausdruecklich sichtbar. Die Entscheidung gilt nicht fuer neue Versionen.

## Freigabepfad

Der Docker-Sammelposten darf erst auf `allowed` wechseln, wenn:

1. Schema 3 in finalen amd64- und arm64-Images erfolgreich geprueft wurde,
2. neue oder geaenderte globale npm-Einzelfaelle entschieden sind,
3. die pip-Abhaengigkeiten reproduzierbar gepinnt und native Wheel-Bestandteile
   samt Quellen erfasst sind,
4. fuer jedes dpkg-Source-Paket und jede sourcepflichtige Native-Komponente
   ein releasefestes, gehashtes Source-Angebot bereitsteht,
5. Notices, Runtime-Inventar und Source-Manifest neben dem Image offline
   beziehungsweise gleichwertig erreichbar sind,
6. ein benannter verantwortlicher oder rechtlicher Reviewer die konkrete
   Plattformmatrix freigibt.

Bis dahin muss `npm run test:licenses:release` fehlschlagen.
