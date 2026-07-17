# Third-Party Release Approval – Kandidat 2026.7.17.1

Stand: 2026-07-17

## Freigabebezug

- Produktversion: Kandidat `2026.7.17.1`
- gepruefter Source-Ausgangscommit vor Aufnahme dieses Freigabebelegs: `546a316cccc10ea59b12cd7942cf3e9c54bc8262`
- `package-lock.json` SHA-256: `900689ec66bf8da07a175d3ed8abb6184b2bb2c80c7e1b838e1b08561f859b2a`
- `third-party-components.json` SHA-256: `58b0618c910a845d8094f186c3cdb95ef3ce57cf060b3ede3548c79dd46a84b4`
- `THIRD_PARTY_NOTICES.md` SHA-256: `65248b008832fdb0e109c34e173506c03aae72411cc6985c62711a6acba8307d`
- Docker-Basisimage: `node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`
- vorhandener Linux-arm64-Auditbeleg: Testimage `sha256:d8a3666463040b15e03688e32807fd4ff656a7430ee37532e98f3423b1081409`
- vorhandener Runtime-Inventar-Hash: `80b985ec9a8e7c5d0a58923fbfbf481df465eddf7fbecf2e0203b2a5d242f078`
- gepruefte Plattformen: macOS arm64 fuer den Source-/Build-Bestand und Linux arm64 fuer den vorhandenen Container-Audit
- noch nicht artefaktbezogen geprueft: finales Linux amd64 und das aus dem Kandidatencommit gebaute finale Linux arm64

Der Docker-Auditbeleg stammt vom 16. Juli 2026 und ist kein Hash eines aus
dem oben genannten Source-Ausgangscommit samt diesem Freigabebeleg gebauten
finalen Multi-Architecture-Releaseimages. Lokal wurde fuer diese Freigabe kein
neuer Container gebaut.

## Verantwortliche Entscheidung

- technische Vorbereitung: Canvas-Lizenzinventar und Codex-gestuetzter Audit
- verantwortlicher Reviewer: Frank Alexander Weber
- Rolle: verantwortlicher Produkt- und Repository-Owner
- Rechtsberatung: keine als solche dokumentiert
- Reviewdatum: 2026-07-17
- digitale Freigabereferenz: ausdrueckliche Freigabe im zugehoerigen Codex-Task am 17. Juli 2026

Der Reviewer hat den ersten deterministischen Gesamtbestand formal
freigegeben und fuer die unten aufgefuehrten exakten Paketversionen eine
verantwortliche Restrisikoentscheidung getroffen. Diese Entscheidung ist
keine Behauptung, dass die Upstream-Belege vollstaendig oder zweifelsfrei
sind. Sie gilt nur fuer die genannten Versionen, unveraenderte Nutzung und
die dokumentierten Lieferartefakte.

## Versionsgebundene Restrisikoentscheidungen

| Komponente | Lizenz | bestverfuegbare Attribution | fehlender Primaerbeleg | Entscheidung |
| --- | --- | --- | --- | --- |
| `@apm-js-collab/code-transformer-bundler-plugins@0.5.0` | MIT | Projekt-Contributors | LICENSE und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `@better-auth/utils@0.4.2` | MIT | Bereket Engida und Contributors | LICENSE und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `@eigenpal/docx-js-editor@0.5.3` | MIT | EigenPal und Contributors | historisches Repository, LICENSE und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `client-only@0.0.1` | MIT | Sebastian Markbåge und Contributors | Repository, Provenance, LICENSE und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `dingbat-to-unicode@1.0.1` | BSD-2-Clause | Michael Williamson und Contributors | mitgelieferter Lizenztext und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `github-from-package@0.0.0` | MIT | James Halliday und Contributors | Rechteinhaberzeile im vorhandenen MIT-Text | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `https@1.0.0` | ISC | hardus van der berg und Contributors | mitgelieferter Lizenztext, Repository und Provenance | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `is-reference@1.2.1` | MIT | Rich Harris und Contributors | vollstaendiger mitgelieferter MIT-Text und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `server-only@0.0.1` | MIT | Sebastian Markbåge und Contributors | Autor, Repository, Provenance, LICENSE und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `webworkify@1.5.0` | MIT | James Halliday und Contributors | Rechteinhaberzeile im vorhandenen MIT-Text | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `docker-global-npm:@npmcli/agent@4.0.0` | ISC | GitHub, Inc. und Contributors | mitgelieferter Lizenztext und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `docker-global-npm:err-code@2.0.3` | MIT | IndigoUnited und Contributors | vollstaendiger mitgelieferter MIT-Text und ausdrueckliche Rechteinhaberzeile | `allowed` fuer diese Version unter dokumentiertem Restrisiko |
| `docker-global-npm:spdx-exceptions@2.5.0` | CC-BY-3.0 | The Linux Foundation; Package-Contribution von Kyle E. Mitchell | mitgelieferter Legal Code und ausdrueckliche Attribution im Tarball | `allowed` fuer diese Version unter dokumentiertem Restrisiko |

Canvas liefert fuer diese Positionen den kanonischen beziehungsweise
offiziellen Lizenztext, die bestverfuegbare Publisher-Attribution, exakte
Version, Integrity/Commit und unveraenderliche Quelle aus. Die Attributionen
sind als verantwortliche Best-Evidence-Entscheidung gekennzeichnet und werden
nicht als nachtraeglich gefundene Upstream-Copyright-Notices dargestellt.

Jedes Upgrade, eine geaenderte Quelle, ein neuer Tarball oder eine geaenderte
Auslieferungsform hebt die Entscheidung fuer die betroffene Position auf und
erfordert eine neue Pruefung.

## Erneute Docker-Pruefung

Der gepinnte Node-Image-Index, seine amd64-/arm64-Manifeste, die aggregierte
Node-Lizenz sowie der vorhandene arm64-Bestand sind versionsgenau
dokumentiert. Der vorhandene Schema-3-Audit erfasst 408 Debian-Binaerpakete,
48 Python-Distributionen und 153 globale npm-Paketpfade.

Der Sammelposten `node-docker-base` bleibt dennoch `review_required`, weil:

1. apt- und pip-Abhaengigkeiten beim Imagebau derzeit nicht vollstaendig
   versions- und hashgepinnt sind,
2. das finale amd64-Image noch keinen gleichwertigen Schema-3-Artefaktbeleg
   besitzt,
3. der vorhandene arm64-Beleg nicht aus dem finalen Kandidatencommit stammt,
4. fuer dpkg-Source-Pakete und native Bestandteile noch kein releasegebundenes
   Corresponding-Source-Manifest mit dauerhaftem Bezugsort vorliegt.

Eine pauschale Owner-Freigabe wuerde diese tatsaechlichen Artefakt- und
Weitergabepflichten nicht erfuellen. Die drei globalen npm-Einzelfaelle sind
dagegen durch die oben dokumentierte versionsgebundene Restrisikoentscheidung
entschieden.

## Erneute sharp-/libvips-Pruefung

Die 28 Lockfile-Positionen repraesentieren zwei sharp-/libvips-Linien und
mehrere optionale Zielplattformen. Ein konkretes amd64-/arm64-Dockerimage
liefert nur seine jeweiligen Linux-Binaerpakete aus; Electron- und andere
Plattformartefakte koennen weitere Positionen ausliefern. Nicht installierte
optionale Lockfile-Pakete sind kein Binaerlieferumfang, bleiben aber fuer
spaetere Zielartefakte sichtbar.

Die tatsaechlich ausgelieferten POSIX-Binaerarchive enthalten zahlreiche
statisch eingebaute Bibliotheken und keine vollstaendige Sammlung der
Lizenztexte. Die offizielle LGPLv3 verlangt bei Combined Works unter anderem
GPL-/LGPL-Texte, Hinweise, Minimal Corresponding Source und Application Code
zum Relinking oder einen nachweislich geeigneten austauschbaren Shared-
Library-Mechanismus. Fuer Downloads muss der Corresponding Source gleichwertig
und dauerhaft erreichbar sein.

Deshalb bleiben alle 28 Eintraege bis zur artefaktbezogenen Eingrenzung und
die tatsaechlich ausgelieferten Eintraege bis zu Source-/Notice-Bundle,
Relinking-/Austauschtest und Installationsdokumentation `review_required`.
Eine verantwortliche Risikoannahme ersetzt diese Lizenzbedingungen nicht.

## Abschlussentscheidung

- [x] erster deterministischer Gesamtbestand durch den verantwortlichen Owner freigegeben
- [x] 13 exakte Pakete unter transparent dokumentiertem Restrisiko freigegeben
- [ ] finales Multi-Architecture-Dockerartefakt freigegeben
- [ ] sharp-/libvips-Source-, Notice- und Relinking-Pflichten nachgewiesen
- [ ] kommerzieller Binaer-/Container-Release insgesamt freigegeben

Der erste Bestandsfreigabe-Blocker und die 13 einzeln entschiedenen
Attributionspositionen duerfen in der versionierten Policy auf `approved`
beziehungsweise `allowed` wechseln. `node-docker-base` und die 28
sharp-/libvips-Positionen bleiben eigenstaendige harte Release-Blocker.

Die Freigabe ist damit dokumentarisch wirksam, aber noch keine Erlaubnis, das
aktuelle Multi-Architecture-Dockerrelease zu veroeffentlichen. Das strikte
Release-Gate muss bis zur technischen Erfuellung der verbleibenden Pflichten
rot bleiben.
