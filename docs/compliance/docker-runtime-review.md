# Docker Runtime License Review

## Current dictation-image status, 2026-09-28

The July Schema-4 approval below covers the earlier 45-package Python lock.
The [dictation dependency intake](dictation-python-dependency-intake-2026-09-28.md)
records the later 58-package images and their bundled PyAV/FFmpeg GPL codec
finding. The current source moves those 13 additional wheels to an explicit,
post-deployment installation under `/data`; see the
[optional runtime design](optional-dictation-runtime-2026-09-28.md). They are no
longer in the Docker build's Python lock. The fresh local amd64/arm64 image
audit at Notebook `c2f4e1ef8` is recorded in
[optional-dictation-boundary-review-2026-09-29.md](optional-dictation-boundary-review-2026-09-29.md).
It verifies the base-image composition, but the optional installation path
and its native dependency obligations still need a version-specific owner
decision. One release blocker remains; no new commercial-release approval is
recorded here.

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
noch fuer den vorhandenen lokalen Vier-Dienste-Teststack eingesetzt. Die
Owner-Freigabe steht weiterhin aus.

### Zwei aktuelle lokale Plattform-Images

Fuer den Lizenz-Branch `bcf0385a8` wurden am 28. September beide
Plattform-Images isoliert gebaut und ohne Starten eines App-Containers aus
den Images geprueft. Die folgenden Werte sind lokale Image-IDs und
Inventar-Dateihashes, keine veroeffentlichten Multi-Arch-Manifest-Digests:

| Plattform | lokale Image-ID | SHA-256 des Schema-4-Inventars | Debian-Binaries / Sources | Python / globales npm |
| --- | --- | --- | ---: | ---: |
| linux/amd64 | `sha256:014f6295918966ebe1801ea76d7a238fc9130055ed34370ec74b331340a6de02` | `46a3e729e020786beacf7798d8cf2968d52d15b6201586e595eb2ba838bdafe1` | 513 / 341 | 61 / 153 |
| linux/arm64 | `sha256:e356cf4d58efe41fd371cfae28f20aafbdb1b8f40623f2a2a0a1dc71b81318e8` | `63b6b70196519cc053f892b74e9513d7ec87115d2778edebae7ba10d6dfceebe` | 509 / 339 | 61 / 153 |

Auf beiden Images bestand
`scripts/runtime-component-inventory-test.mjs` mit dem aktuellen
Python-Lock und der Native-Policy. Das gemeinsame
`scripts/runtime-multiarch-compliance-test.mjs` bestand mit beiden
Inventaren und Sharp-Linkage-Dateien. Dockerfile-, Policy- und
Python-Lock-Hashes sind zwischen den Inventaren gleich; auch alle 61
Python-Namen/Versionen stimmen ueberein, davon 58 per pip installierte
Pakete. Die extrahierten Notices und das statische Komponentenmanifest
stimmen auf beiden Plattformen bytegenau mit dem Branch ueberein; das
mitgelieferte libvips-Quellarchiv besteht auf beiden den erwarteten
SHA-256-Test `3c41e1d5458081bfa4a5bc54e116c46259c75c6760a18027764555632b9dda3e`.

Die folgenden Zahlen stammen aus den `RECORD`-Dateien der exakt in
beiden Images installierten 13 neuen Wheels. Die erste Zahl gilt fuer
amd64, die zweite fuer arm64. „Native Dateien“ zaehlt `.so`-Eintraege
einschliesslich gebuendelter Bibliotheken; die Lizenzangabe stammt nur
aus Wheel-Metadaten und ist noch keine Entscheidung ueber diese Dateien.

| Wheel | Lizenzangabe | Wheel-eigene Lizenzdateien | Native Dateien |
| --- | --- | ---: | ---: |
| `anyio@4.15.1` | MIT | 1 / 1 | 0 / 0 |
| `av@18.1.0` | BSD-3-Clause | 3 / 3 | 81 / 80 |
| `ctranslate2@4.8.2` | MIT | 0 / 0 | 3 / 3 |
| `faster-whisper@1.2.1` | MIT | 1 / 1 | 0 / 0 |
| `filelock@4.0.5` | MIT | 1 / 1 | 0 / 0 |
| `fsspec@2026.9.0` | BSD-3-Clause | 1 / 1 | 0 / 0 |
| `h11@0.16.0` | MIT | 1 / 1 | 0 / 0 |
| `hf-xet@1.6.0` | Apache-2.0 | 1 / 1 | 1 / 1 |
| `httpcore@1.0.9` | BSD-3-Clause | 1 / 1 | 0 / 0 |
| `httpx@0.28.1` | BSD-3-Clause | 1 / 1 | 0 / 0 |
| `huggingface-hub@1.33.0` | Apache-2.0 | 1 / 1 | 0 / 0 |
| `tokenizers@0.23.2` | keine Wheel-Angabe | 0 / 0 | 1 / 1 |
| `tqdm@4.70.1` | MPL-2.0 AND MIT | 1 / 1 | 0 / 0 |

PyAVs `RECORD` fuehrt unter anderem eigene `av.libs`-Kopien von
`libavcodec`, `libavformat`, `libx264` und `libx265`; `libvpl`
steht nur im amd64-Wheel. `ctranslate2` liefert neben seiner
Python-Erweiterung eine eigene `libctranslate2` und `libgomp`.
`hf-xet` und `tokenizers` enthalten jeweils eine native
Python-Erweiterung. Diese genaue Payload und die fehlenden Wheel-Texte
bei `ctranslate2` und `tokenizers` sind Gegenstand der offenen
Einzelpruefung; der gebundene externe Apache-Text fuer `tokenizers`
ist oben dokumentiert.

Fuer `hf-xet@1.6.0` erfasst
[`hf-xet-native-evidence.json`](hf-xet-native-evidence.json) die native
Erweiterung aus genau diesen beiden historischen lokalen Images. Das
[`capture-hf-xet-native-evidence.py`](../../scripts/capture-hf-xet-native-evidence.py)
prueft den SHA-256-Hash und die Groesse gegen den jeweiligen Wheel-`RECORD`-
Eintrag, die ELF-Architektur und die dynamisch benoetigten Bibliotheken.
Die Erweiterung hat SHA-256
`9f493e4d60ce7d973f77d6e638efc9fa59329967de8b17d2fb83baf3ed8d73b9`
auf amd64 und
`bcc6a3cbf4e36c16df2c40c5b124852be2acb293fc4130e11224029a04adc383`
auf arm64; beide `RECORD`-Pruefungen bestehen. Dies belegt den Inhalt und
die dynamische Linkage dieser historischen Images. Herkunft und Rechte
statisch eingebetteter Rust-/Drittkomponenten sowie die kommerzielle
Freigabe bleiben offen. Ein neuer Release-Image-Build muss separat gegen
seine eigene Image-ID geprueft werden.

Der fruehere Diktat-Image-Kandidat hatte eine architekturspezifische Pruefung
dieser Erweiterung im Release-Workflow. Im aktuellen Basis-Image fehlen die
optionalen Diktat-Wheels absichtlich; der Release-Workflow fordert daher
keine `hf-xet`-Erweiterung mehr an und archiviert fuer dieses Basis-Image
keinen solchen Nachweis. Das getrennte Capture-Skript bleibt fuer eine
spaetere Pruefung der optionalen Installation verfuegbar. Der aktuelle
Release-Pfad prueft stattdessen die Abwesenheit aller 13 optionalen Pakete im
Runtime-Inventar. Ein neuer amd64-/arm64-Image-Build fuer diesen Draft-PR
steht noch aus.

Der exakte CTranslate2-Tag `v4.8.2` verweist auf Commit
`d44d2d069eb88c7b7804da864c10c201501cb4a9`. Sein
[MIT-Lizenztext](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/LICENSE)
hat SHA-256 `54aa79d9fe3c09e67a16dcd95b9e88676405a6ec174efda31036983cf7672ecb`
und ist nun als separate Notice gebunden. Beide Linux-Wheels enthalten
selbst keine Lizenzdatei. Die drei nativen Dateien pro Architektur,
einschliesslich `libgomp`, bleiben weiterhin in der offenen Einzelpruefung.
Die Python-Erweiterung laedt die gebuendelten `libctranslate2` und
`libgomp` auf beiden Plattformen. Die mitgelieferte `libgomp` ist nicht
bytegleich mit der Debian-`libgomp1` im selben Image; ihre SHA-256-Werte
sind amd64 `a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a`
und arm64 `43642df04bdf20f9b4122d336ef3e2e6a486c536e614159ac0e981a901d54537`.
[GCC-12.2-Quellcode](https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-12.2.0/libgomp/parallel.c)
nennt GPLv3+ mit [Runtime Library Exception 3.1](https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-12.2.0/COPYING.RUNTIME);
dies belegt noch nicht, aus welchem GCC-Build die konkreten Wheel-Dateien
stammen. Vor einer Freigabe fehlen das exakte Wheel-Build-Rezept und die
Compiler-/Drittkomponenten-Versionen, die Pruefung statisch eingebetteter
Bibliotheken sowie passende Lizenztexte und Quellcode-Nachweise pro
Architektur. Der bereits gebundene MIT-Text deckt nur den nachgewiesenen
CTranslate2-Quellstand ab und ist keine Freigabe dieser Payload.

Zusaetzlicher Befund zu den exakt gelockten PyAV-18.1.0-Wheels:
`libavcodec` bindet in beiden Images die im Wheel enthaltenen
`libx264` und `libx265` direkt. Das Wheel liefert nur PyAVs
BSD-3-Clause-Lizenztext; fuer die beiden Encoder liegt im Wheel kein
eigener Lizenztext oder Nachweis einer kommerziellen Lizenz. Ein
schreibgeschuetzter Offline-Aufruf von `avcodec_license()` in beiden
Images meldet `LGPL version 3 or later`, waehrend die Build-Konfiguration
`--enable-libx264 --enable-libx265 --enable-version3`, aber kein
`--enable-gpl` enthaelt. Das weicht von der
[FFmpeg-Dokumentation zu x264/x265](https://www.ffmpeg.org/general.html#x264)
und den [FFmpeg-Lizenzhinweisen](https://ffmpeg.org/legal.html) ab.
Vor einer Freigabe muss der Owner Herkunft und Nutzungsrechte der exakten
x264-/x265-Binaerdateien und den FFmpeg-Lizenzmodus klaeren oder ein
Image mit einer entsprechend anders gebauten, erneut inventarisierten
Wheel-Variante pruefen. Dies ist ein technischer Befund, keine rechtliche
Bewertung oder Freigabe. Die genannten Image-IDs gehoeren zum vorherigen
Produkt-Head `bcf0385a8`; nach Aenderungen an Notice oder Policy sind
deren eingebettete Compliance-Artefakte nicht mehr aktuell.

Auch das separat installierte Debian-`ffmpeg` meldet in beiden exakten
Images bei `ffmpeg -buildconf` die Flags `--enable-gpl`,
`--enable-libx264` und `--enable-libx265`. Ein PyAV-Source-Build gegen
dieses System-FFmpeg behebt den Befund deshalb nicht. Das CLI wird in
`app/lib/files/media-preview.ts` fuer Medienvorschauen genutzt; PyAV
kommt ueber Faster-Whisper fuer das Diktat hinzu. Wenn der Release-Owner
eine Variante ohne diese Encoder waehlt, muss er ein entsprechend
konfiguriertes, versions- und quellgebundenes FFmpeg fuer CLI und
PyAV-Wheels auf amd64 und arm64 bereitstellen. Danach sind Hash-Lock,
Lizenzmodus, dynamische Bibliotheksbindungen, Notices und Source-Archive
im finalen Image erneut zu pruefen. Die Medienvorschau und die Diktat-
Eingaben WebM, Ogg, M4A, MP3 und WAV muessen dabei weiter funktionieren.
Andere GPL-Komponenten im Image sind davon unabhaengig zu pruefen.

Diese technische Plattformpruefung ist keine kommerzielle Freigabe und
keine produktive Bereitstellung. Der statische Release-Gate blockiert
weiterhin 14 Eintraege: die neue Gesamtfreigabe und die Einzelpruefung
aller 13 neu hinzugefuegten Python-Pakete, einschliesslich der kombinierten
MPL-/MIT-Pflichten von `tqdm`. Ein spaeter veroeffentlichtes Image muss
mit seinen tatsaechlichen Manifest-Digests und denselben Gates erneut
geprueft werden.

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
