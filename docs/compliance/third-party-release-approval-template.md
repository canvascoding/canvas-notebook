# Third-Party Release Approval

Diese Vorlage wird fuer die erste kommerzielle Bestandsfreigabe und danach fuer
neue oder geaenderte reviewpflichtige Komponenten verwendet. Sie ist ohne
ausgefuellte Felder keine Freigabe.

## Release-Bezug

- Produktversion:
- Git-Commit:
- Datum:
- `package-lock.json` SHA-256:
- Docker-Image-Digest:
- Docker-Basisimage und Digest:
- gepruefte Plattformen/Architekturen:
- gepruefte Distributionsartefakte:

## Verantwortliche Personen

- technische Vorbereitung:
- verantwortlicher Reviewer:
- Rolle/Organisation:
- gegebenenfalls Rechtsberatung:
- Reviewdatum:

## Automatische Nachweise

- [ ] `npm run test:licenses` erfolgreich
- [ ] `npm run licenses:generate` erzeugt keinen ungelesenen Drift
- [ ] `third-party-components.json` stimmt mit Lockfile und Lieferumfang
- [ ] `THIRD_PARTY_NOTICES.md` ist reproduzierbar
- [ ] Docker-Runtime-Inventar wurde aus dem finalen Image erzeugt
- [ ] Source-, Docker-, CLI- und Electron-Artefakte enthalten die Notices
- [ ] Legal-UI und authentifizierte Download-Endpunkte wurden geprueft
- [ ] anonymer Zugriff auf Legal-API bleibt gesperrt

## Reviewpflichtige Komponenten

Fuer jede Position eine Zeile oder einen eigenen Abschnitt anlegen.

| Komponente | Version/Commit | Lieferartefakt | deklarierte Lizenz | gewaehlte/verifizierte Lizenz | Belegquelle und Hash | Pflichten | Entscheidung | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |

Zulaessige Entscheidungen:

- `allowed`: fuer die dokumentierte Nutzung und Auslieferungsform freigegeben,
- `replace_or_remove`: vor dem Release ersetzen oder entfernen,
- `blocked`: darf nicht in das kommerzielle Artefakt,
- `pending`: Freigabe noch nicht erteilt.

## Mehrfachlizenz-Entscheidungen

| Komponente | angebotene Alternativen | ausgewaehlte Lizenz | Grund der Auswahl | erfuellte Pflichten | Reviewer/Datum |
| --- | --- | --- | --- | --- | --- |
| `@zone-eu/mailsplit` | MIT OR EUPL-1.1+ |  |  |  |  |
| `dompurify` | MPL-2.0 OR Apache-2.0 |  |  |  |  |
| `jszip` | MIT OR GPL-3.0-or-later |  |  |  |  |

## Docker-, OS- und native Komponenten

- finaler Debian-Lieferumfang geprueft:
- finaler Python-/pip-Lieferumfang geprueft:
- `sharp`-/`libvips`-Plattformpakete geprueft:
- LGPL-/Relinking-/Source-Pflichten bewertet:
- im Image enthaltene Lizenz-/Copyright-Belege lesbar:
- Abweichungen zwischen Build- und Runtime-Image:
- Entscheidung und Begruendung:

## Fehlende oder unvollstaendige Upstream-Belege

Fuer jede Position dokumentieren:

- Paket und exakte Version:
- npm-Tarball:
- Upstream-Repository und unveraenderlicher Commit:
- gefundener Lizenztext:
- belastbarer Copyright-Hinweis:
- Grund, warum der Beleg zur exakten Release-Version gehoert:
- Entscheidung: Override, Upstream-Fix/Upgrade, Ersatz, Entfernung oder Block:

## Kopierter oder veraenderter Upstream-Code

| Komponente | Upstream-Datei | Version/Commit | Canvas-Zieldatei | Aenderungen | Lizenz-/Copyright-Hinweis ausgeliefert |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

Fuer Excalidraw-Collaboration insbesondere pruefen:

- [ ] nur oeffentliche npm-APIs genutzt, kein Upstream-Code kopiert, oder
- [ ] jeder uebernommene Teil aus `excalidraw-app/collab`,
      `excalidraw-room` oder anderen Quellen ist einzeln inventarisiert
- [ ] exakte Excalidraw-Version beziehungsweise Commit dokumentiert
- [ ] MIT-Text und `Copyright (c) 2020 Excalidraw` ausgeliefert
- [ ] Canvas-Modifikationen nachvollziehbar beschrieben
- [ ] keine Excalidraw-Marken- oder Excalidraw+-Rechte unterstellt

## Artefaktpruefung

| Artefakt | Version/Hash | Lizenz vorhanden | Notices vorhanden | Manifest vorhanden | geprueft von |
| --- | --- | --- | --- | --- | --- |
| Source-Release |  |  |  |  |  |
| Docker-Image |  |  |  |  |  |
| Portable CLI |  |  |  |  |  |
| Host CLI |  |  |  |  |  |
| Electron macOS |  |  |  |  |  |
| Electron Windows |  |  |  |  |  |
| Electron Linux |  |  |  |  |  |

## Restliche Risiken oder Auflagen

- offene Punkte:
- zeitlich begrenzte Freigaben:
- erforderliche Upstream-Upgrades:
- Source-/Notice-Bereitstellungsort:
- naechster Review-Ausloeser:

## Abschlussentscheidung

- [ ] freigegeben
- [ ] freigegeben unter den dokumentierten Auflagen
- [ ] nicht freigegeben
- [ ] weiterhin ausstehend

Begruendung:

Name:

Rolle:

Datum:

Unterschrift beziehungsweise nachvollziehbare digitale Freigabereferenz:

## Uebertragung in die versionierte Policy

Nach erteilter Freigabe:

1. Paketentscheidungen und Belege in
   `docs/compliance/third-party-license-policy.json` eintragen.
2. `releaseApproval.status`, `reviewedBy`, `reviewedAt` und `notes` nur auf
   Basis dieser dokumentierten Freigabe aktualisieren.
3. `npm run licenses:refresh-cache` nur ausfuehren, wenn neue Belege benoetigt
   werden.
4. `npm run licenses:generate` ausfuehren.
5. Diff von Policy, Cache, Manifest und Notices reviewen.
6. `npm run verify:release` erfolgreich ausfuehren.
7. Freigabenachweis zusammen mit dem Release aufbewahren.
