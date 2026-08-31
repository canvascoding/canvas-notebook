# Plan: persoenliches Benutzerprofil mit Foto, Icons und Initialen

Stand: 2026-08-31
Status: implementiert und technisch verifiziert
Branch: `codex/user-profile-avatar-plan`

## Zielbild

Jeder angemeldete Benutzer kann seine persoenliche Darstellung selbst waehlen:

1. ein eigenes Profilfoto hochladen,
2. alternativ ein Icon aus einem kuratierten Katalog auswaehlen oder
3. die automatisch gebildeten Initialen verwenden.

Auf der Startseite wird eine kompakte Profilanzeige aus Avatar und Benutzername dargestellt. Dieselbe Darstellung wird im persoenlichen Bereich der allgemeinen Einstellungen bearbeitet und bereits waehrend des persoenlichen Onboardings angeboten.

Die Aufloesungsreihenfolge ist verbindlich:

`hochgeladenes Foto -> ausgewaehltes Icon -> Initialen`

Als Form wird fuer V1 ein abgerundetes Quadrat (`rounded-lg`) verwendet. Das passt zu den bestehenden kompakten Controls in Canvas Notebook und funktioniert gleich gut fuer Fotos, Icons und Initialen. Eine frei waehlbare Form ist nicht Teil von V1.

## Bestehender Stand

- Better Auth liefert bereits `session.user.name` und `session.user.image`.
- Die Tabelle `user` besitzt bereits die Spalten `name` und `image`. Eine neue Profil- oder Bildspalte ist fuer V1 nicht erforderlich.
- Die Startseite wird serverseitig in `app/[locale]/(routes)/page.tsx` aufgebaut.
- Die allgemeinen persoenlichen Einstellungen liegen in `GeneralSettingsPanel` und zeigen den Namen bisher nur lesend an.
- Das persoenliche Onboarding beginnt mit der Sprachauswahl. Der vorhandene spaetere Schritt `profile` erstellt dagegen das Profil des Canvas Agents und darf nicht fuer das Benutzerbild umgedeutet werden.
- User-spezifische Dateien haben bereits einen vorgesehenen persistenten Bereich unter `/data/users/<userId>/`.
- Fuer sichere Bildnormalisierung stehen `sharp`, `file-type`, multipart-Helfer und bestehende Logo-Upload-Muster zur Verfuegung.

## Architekturentscheidung

### Kein neuer Onboarding-Schritt

Die Avatar-Auswahl wird als Abschnitt direkt in den vorhandenen `LanguageStep` integriert. Damit liegt sie wie gewuenscht bei der persoenlichen Sprachwahl, bleibt optional und fuehrt keine zweite Bedeutung fuer den bereits belegten Schritt `profile` ein.

Diese Entscheidung vermeidet ausserdem eine Migration des zentralen `UserOnboardingState`. Die GitNexus-Analyse bewertet `normalizeUserOnboardingState` als `CRITICAL` (21 betroffene Symbole, 12 Module) und den allgemeinen Preferences-Writer als `HIGH`. Ein neuer resumierbarer Onboarding-Schritt waere fuer eine optionale Personalisierung unverhaeltnismaessig riskant.

### Eigener User-Profile-Service

Die Logik wird nicht in den allgemeinen User Preferences untergebracht. Ein eigener serverseitiger Service kapselt:

- Lesen der effektiven Profildarstellung,
- Validieren und Speichern einer Icon-Auswahl,
- Bildnormalisierung und atomisches Ersetzen,
- Entfernen eines Bildes,
- Synchronisieren von `user.image`,
- Revision und Cache-Busting sowie
- den Fallback auf Initialen.

Damit bleiben Locale-, E-Mail-, Mobile- und Agent-Preferences von den neuen Schreibpfaden unberuehrt.

## Datenmodell und Speicherung

### Persistente Dateien

```text
/data/users/<normalisierte-user-id>/profile/
  appearance.json
  avatar.webp
```

`appearance.json` ist die kanonische Auswahl fuer die Darstellung:

```json
{
  "version": 1,
  "avatarKind": "image",
  "iconId": null,
  "revision": 3,
  "updatedAt": "2026-08-31T12:00:00.000Z"
}
```

Zulaessige Werte fuer `avatarKind` sind `image`, `icon` und `initials`. `iconId` ist nur bei `icon` gesetzt und muss in der serverseitigen Allowlist enthalten sein.

`user.image` enthaelt bei einem aktiven Foto nur eine stabile interne URL, beispielsweise `/api/account/profile/avatar?v=3`. Es werden weder Bilddaten noch absolute Dateisystempfade in der Datenbank gespeichert. Bei Icon oder Initialen wird `user.image` auf `null` gesetzt.

Vorteile dieser Aufteilung:

- keine Datenbankmigration fuer SQLite oder PostgreSQL,
- keine Base64-Bilder in Session- oder API-Payloads,
- persistente Sicherung zusammen mit dem bestehenden `/data`-Volume,
- user-spezifische Isolation und einfache spaetere Bereinigung,
- Better-Auth- und Mobile-Clients sehen ein Foto weiterhin ueber das bestehende Feld `image`.

### Dateirechte und Konsistenz

- Profilverzeichnis: Modus `0700`.
- Dateien: Modus `0600`.
- User-IDs werden ausschliesslich ueber `normalizeDataScopeId` in Pfade ueberfuehrt.
- Schreibvorgaenge laufen unter einem per User gekeyten Lock.
- `appearance.json` und `avatar.webp` werden ueber temporaere Dateien und atomisches Rename ersetzt.
- Bei einem Fehler zwischen Dateischreibvorgang und DB-Update wird der vorherige Zustand wiederhergestellt oder der neue unvollstaendige Zustand entfernt.
- Beim Wechsel zu Icon oder Initialen wird das alte Foto geloescht, damit keine unerwartet weiter gespeicherten personenbezogenen Bilddaten zurueckbleiben.
- Eine Sperrung des Users behaelt die Dateien entsprechend dem bestehenden Recovery-Modell. Ein spaeterer Hard-Delete muss das Verzeichnis mit entfernen.

## Bild-Pipeline

Der Server akzeptiert genau eine Datei und vertraut weder Dateiendung noch Browser-MIME-Type.

- Eingabeformate: PNG, JPEG, WebP und HEIC/HEIF, soweit der vorhandene Decoder sie sicher verarbeiten kann.
- Maximale Request-/Dateigroesse: 5 MB.
- Maximale Eingangspixelzahl: 20 Megapixel.
- Animierte oder mehrseitige Dateien werden abgelehnt.
- EXIF-Orientierung wird angewendet; Metadaten werden beim Neuschreiben entfernt.
- Ausgabe: quadratisches WebP, 256 x 256 Pixel, `fit: cover`, mittiger Ausschnitt.
- Zielgroesse: maximal 256 KB; bei Ueberschreitung wird mit niedrigerer Qualitaet erneut kodiert oder der Upload abgelehnt.
- Kein Import ueber externe URLs. Dadurch entstehen weder SSRF- noch Tracking-Risiken.

Ein eigenes Crop-UI ist nicht Teil von V1. Nach dem Upload zeigt die Vorschau ausschliesslich die bereits serverseitig normalisierte und gespeicherte Fassung.

## Icon-Katalog

Der Katalog wird als gemeinsame, versionierte Allowlist mit stabilen IDs definiert. Die UI importiert die zugehoerigen Lucide-Komponenten ueber eine explizite Map; der Server akzeptiert keine beliebigen Icon-Namen.

Vorgesehene V1-Auswahl:

| ID | Bedeutung |
| --- | --- |
| `user-round` | neutral/personenbezogen |
| `smile` | freundlich |
| `sparkles` | kreativ |
| `rocket` | ambitioniert |
| `palette` | Design/Kreativitaet |
| `code-2` | Entwicklung |
| `book-open` | Lernen/Wissen |
| `camera` | Foto/Medien |
| `music` | Musik |
| `coffee` | Alltag/Fokus |
| `mountain` | Outdoor/Ziele |
| `leaf` | Natur/Ruhe |

Die Auswahl bleibt bewusst klein und eindeutig. Bezeichnungen und Hilfetexte werden in Deutsch und Englisch uebersetzt. Farbe und Hintergrund folgen in V1 dem Theme; eine eigene Farbauswahl ist ein moeglicher spaeterer Ausbau.

## Initialen-Fallback

Eine reine Helper-Funktion erzeugt hoechstens zwei Unicode-faehige Initialen:

- Vor- und Nachname: erstes Graphem des ersten und letzten Namensbestandteils (`Alex Weber -> AW`).
- Einteiliger Name: erstes Graphem.
- Leerzeichen und Bindestriche werden robust normalisiert.
- Wenn der Name wider Erwarten leer ist, wird der lokale Teil der E-Mail verwendet.
- Wenn auch dieser fehlt, wird ein neutrales User-Icon dargestellt.
- Die Grossschreibung erfolgt locale-aware; Zeichen ausserhalb des ASCII-Bereichs duerfen nicht abgeschnitten werden.

Die Funktion wird separat getestet, damit Startseite, Settings und Onboarding exakt denselben Fallback anzeigen.

## API-Vertrag

Alle Endpunkte arbeiten ausschliesslich auf dem aktuell authentifizierten User. Ein `userId` aus Query oder Body wird nicht akzeptiert.

### `GET /api/account/profile`

Liefert die effektive Darstellung:

```json
{
  "success": true,
  "data": {
    "name": "Alex Weber",
    "avatarKind": "icon",
    "iconId": "sparkles",
    "initials": "AW",
    "imageUrl": null,
    "revision": 3
  }
}
```

### `PATCH /api/account/profile`

Erlaubte Bodies:

```json
{ "avatarKind": "icon", "iconId": "sparkles" }
```

oder

```json
{ "avatarKind": "initials" }
```

Der Wechsel entfernt ein vorhandenes Foto, setzt `user.image` auf `null` und liefert das vollstaendig aufgeloeste Profil zurueck.

### `GET /api/account/profile/avatar?v=<revision>`

Liefert nur das eigene normalisierte Bild mit:

- `Content-Type: image/webp`,
- `X-Content-Type-Options: nosniff`,
- privatem Cache und revisionsbasierter URL sowie
- `ETag` beziehungsweise `Last-Modified` fuer effiziente Wiederholungsaufrufe.

Der Endpunkt bleibt authentifiziert. Eine spaetere Anzeige fremder Benutzerbilder in Collaboration-Ansichten braucht einen getrennten ACL-bewussten Vertrag und wird nicht stillschweigend ueber diesen Self-Endpunkt geloest.

### `POST /api/account/profile/avatar`

Multipart-Upload mit exakt einem Feld `file`. Der Endpunkt validiert Groesse, Magic Bytes, Dimensionen und Bildtyp, normalisiert das Bild, setzt `avatarKind=image`, aktualisiert `user.image` und liefert das aufgeloeste Profil zurueck.

### `DELETE /api/account/profile/avatar`

Loescht das Foto, setzt `user.image` auf `null` und faellt auf Initialen zurueck. Eine Icon-Auswahl erfolgt explizit ueber den PATCH-Endpunkt.

### Schutzmassnahmen

- Session-Pruefung vor dem Parsen grosser Bodies.
- Same-Origin-/CSRF-Pruefung fuer Mutationen.
- Rate Limit, zum Beispiel 10 Mutationen pro Minute und User/IP.
- Content-Length-Pruefung vor `request.formData()` und zusaetzliche File-Size-Pruefung danach.
- Keine User-ID und keine Dateipfade in Fehlermeldungen oder Logs.
- Keine Bildinhalte in Sentry oder normalen Logs.

## Gemeinsame UI-Komponenten

### `UserAvatar`

Eine kleine presentational component erhaelt `name`, `imageUrl`, `iconId`, Groesse und optionale Klassen. Sie entscheidet nicht selbst ueber Storage oder Fetching.

- Foto: `<img>` mit `object-cover` und internem authentifiziertem Endpunkt.
- Icon: explizit gemappte Lucide-Komponente.
- Fallback: Initialen.
- Standardform: abgerundetes Quadrat.
- Fehler beim Laden eines Bildes wechseln clientseitig auf Icon beziehungsweise Initialen.
- Aussagekraeftiger Alt-Text beziehungsweise accessible Name; dekorative Icon-Pfade selbst sind `aria-hidden`.

### `UserProfileBadge`

Kombiniert Avatar und gekuerzten Namen. Auf kleinen Viewports bleibt mindestens der Avatar sichtbar, der volle Name bleibt fuer Screenreader verfuegbar. Auf groesseren Viewports wird der Name visuell angezeigt.

### `ProfileAppearanceEditor`

Wird von Settings und Onboarding gemeinsam verwendet:

- aktuelle Vorschau mit Name,
- Datei-Auswahl inklusive Drop-/Choose-UI,
- Icon-Grid mit klar erkennbarem Auswahlzustand,
- Option „Initialen verwenden“,
- Upload-/Speicherzustand und lokale Validierungsfehler,
- Entfernen/Ersetzen des vorhandenen Fotos,
- keine optimistische dauerhafte Anzeige vor erfolgreicher Serverantwort.

## Einbindung in die Oberflaechen

### Startseite

In `app/[locale]/(routes)/page.tsx` wird das Profil serverseitig gemeinsam mit der Session aufgeloest. Im rechten Headerbereich erscheint `UserProfileBadge` vor dem Logout-Button und verlinkt auf `/<locale>/settings?tab=general`.

- Desktop/Tablet: Avatar plus gekuerzter Name.
- Sehr schmale Viewports: Avatar sichtbar, Name visuell ausgeblendet, aber accessible.
- Kein zusaetzlicher Client-Fetch beim ersten Rendern.

### Persoenliche Einstellungen

Im allgemeinen Settings-Bereich wird vor den Login-Informationen ein eigener Accordion-Abschnitt „Persoenliches Profil“ eingefuegt. Er verwendet `ProfileAppearanceEditor` und liegt damit in derselben persoenlichen Umgebung wie Sprache und Zeitzone.

Der Name bleibt in V1 lesend und kommt aus Better Auth. Eine spaetere Selbstbearbeitung des Namens ist eine gesonderte Entscheidung, weil der Name auch Collaboration-Attribution, Admin-Ansichten und Auditdarstellung beeinflusst.

### Persoenliches Onboarding

Der bestehende `LanguageStep` erhaelt nach der Sprachauswahl einen klar getrennten Abschnitt „So wirst du angezeigt“. Die Seite uebergibt den bestehenden Namen und den aufgeloesten Avatarzustand als Initialdaten an den Wizard.

- Foto, Icon und Initialen werden sofort ueber die Profil-API gespeichert.
- Die Personalisierung ist optional; ohne Aktion funktioniert „Weiter“ und die Initialen erscheinen automatisch.
- Ein fehlgeschlagener Upload blockiert nicht das gesamte Onboarding. Der Fehler wird angezeigt, und der Benutzer kann Icon, Initialen oder spaeteres Bearbeiten waehlen.
- Ein Locale-Wechsel laedt den Wizard wie bisher neu; eine bereits gespeicherte Avatar-Auswahl bleibt serverseitig erhalten.
- Der spaetere bestehende `profile`-Schritt bleibt unveraendert der Canvas-Agent-Personalisierung vorbehalten.

## Erwartete Dateien bei der Implementierung

Neue Dateien:

- `app/lib/user-profile/types.ts`
- `app/lib/user-profile/icon-catalog.ts`
- `app/lib/user-profile/initials.ts`
- `app/lib/user-profile/service.ts`
- `app/lib/user-profile/upload.ts`
- `app/api/account/profile/route.ts`
- `app/api/account/profile/avatar/route.ts`
- `app/components/user-profile/UserAvatar.tsx`
- `app/components/user-profile/UserProfileBadge.tsx`
- `app/components/user-profile/ProfileAppearanceEditor.tsx`
- gezielte Service-, API- und UI-Tests unter `scripts/`

Bestehende Dateien mit voraussichtlichen Anpassungen:

- `app/[locale]/(routes)/page.tsx`
- `app/[locale]/(routes)/settings/page.tsx`
- `app/[locale]/(routes)/onboarding/page.tsx`
- `app/[locale]/(routes)/onboarding/onboarding-wizard.tsx`
- `app/components/settings/IntegrationsSettingsClient.tsx`
- `app/components/settings/GeneralSettingsPanel.tsx`
- `messages/de.json`
- `messages/en.json`

`app/lib/db/schema.ts`, `app/lib/db/migrate.ts` und der zentrale `UserOnboardingState` sollen nach aktueller Planung nicht geaendert werden.

## Sequenzieller Umsetzungsplan

Die Todos werden gemaess Repository-Regel streng nacheinander abgeschlossen und jeweils separat committed.

### 1. Domain-Modell und Storage-Service

- Typen, Icon-Allowlist und Initialen-Helper anlegen.
- Pfadauflosung unter `/data/users/<userId>/profile` implementieren.
- atomare JSON-/Bild-Schreibvorgaenge, Revision und DB-Synchronisierung implementieren.
- Service-Tests fuer Lesen, Foto/Icon/Initialen-Wechsel, Parallelzugriffe und Recovery abschliessen.

Abnahmekriterium: Der Service kann jeden Zustand ohne UI und ohne API reproduzierbar aufloesen; keine Aenderung am zentralen Preferences- oder Onboarding-State.

### 2. Authentifizierte Profil-API

- Metadata-, Auswahl- und Avatar-Endpunkte implementieren.
- Upload-Limits, Magic-Byte-Validierung, Bildnormalisierung, Rate Limit und Same-Origin-Schutz hinzufuegen.
- API-Tests fuer Auth, Cross-User-Isolation, ungueltige IDs/MIME-Typen, Oversize, Delete und Cache-Revision abschliessen.

Abnahmekriterium: Kein Request kann einen fremden User oder einen Pfad ausserhalb des eigenen Profilverzeichnisses beeinflussen.

### 3. Gemeinsame Avatar- und Editor-Komponenten

- `UserAvatar`, `UserProfileBadge` und `ProfileAppearanceEditor` implementieren.
- Bildfehler-Fallback, Tastaturbedienung, Fokuszustand, Screenreader-Texte und responsive Darstellung pruefen.
- DE/EN-Texte ergaenzen.

Abnahmekriterium: Eine Komponente zeigt fuer alle drei Varianten denselben aufgeloesten Zustand und kann ohne surface-spezifische Sonderlogik wiederverwendet werden.

### 4. Persoenliche Einstellungen integrieren

- Profilzustand serverseitig in der Settings-Seite laden.
- Editor im allgemeinen persoenlichen Bereich vor den Login-Informationen einbauen.
- Nach jeder Mutation Vorschau und Session-nahe UI aktualisieren.

Abnahmekriterium: Foto, Icon und Initialen koennen nach dem Onboarding jederzeit gewechselt werden und bleiben nach Reload erhalten.

### 5. Onboarding integrieren

- Initialprofil an den Wizard uebergeben.
- Editor als optionalen Abschnitt in `LanguageStep` einbauen.
- Weiter-Navigation bei unveraenderten Initialen sowie bei recoverbaren Uploadfehlern absichern.
- Bestehenden Agent-`profile`-Schritt und seine Completion-Guards unveraendert halten.

Abnahmekriterium: Neue User koennen die Darstellung neben der Sprache personalisieren; bestehende oder bereits begonnene Onboardings brauchen keine State-Migration.

### 6. Startseite integrieren

- Profil serverseitig aufloesen.
- Badge mit Avatar und Name in den Header einsetzen und auf General Settings verlinken.
- schmale, mittlere und grosse Viewports pruefen.

Abnahmekriterium: Auf der Startseite wird der Name mit der gewaehlen Darstellung gezeigt; ohne Auswahl erscheinen korrekte Initialen.

### 7. Vollstaendige Verifikation

- gezielte Service-/API-/UI-Tests ausfuehren,
- `npm run lint`,
- `npm run build`,
- UI und E2E auf dem vorhandenen oder einzigen Dev-Server auf `localhost:3000` pruefen,
- vorher explizite Freigabe fuer Playwright oder Chrome DevTools einholen,
- `detect_changes({scope: "compare", base_ref: "main"})` vor dem finalen Commit ausfuehren.

Es wird kein Container gebaut, solange dies nicht explizit beauftragt ist.

## Testmatrix

### Unit/Service

- `Alex Weber -> AW`, einteilige und Unicode-Namen, leere Werte.
- alle erlaubten und unerlaubten Icon-IDs.
- Default ohne Dateien -> Initialen.
- fehlende oder korrupte `appearance.json` -> sicherer Fallback.
- fehlendes Bild trotz `avatarKind=image` -> Icon/Initialen statt Broken Image.
- parallele Mutationen desselben Users werden serialisiert.
- zwei User koennen keine Dateien oder Metadaten gegenseitig lesen/aendern.

### API

- 401 ohne Session.
- Mutation nur bei gueltigem Same-Origin-Request.
- genau eine Datei, Groessenlimit vor und nach Multipart-Parsing.
- Dateiendung/MIME-Spoofing wird erkannt.
- animierte, korrupte und uebergrosse Bilder werden abgelehnt.
- Ausgabe ist 256 x 256 WebP ohne EXIF.
- Icon/Initialen entfernen Foto und leeren `user.image`.
- Upload setzt `user.image` und erhoeht die Revision.
- GET liefert private Cache-Header und `nosniff`.

### UI/E2E

- Settings: Foto hochladen, Icon auswaehlen, Initialen waehlen, Reload.
- Onboarding: ohne Auswahl weiter; Icon und Foto bleiben nach Locale-Reload erhalten.
- Startseite: Name plus Foto/Icon/Initialen nach Reload.
- Bild-404 fuehrt sichtbar zum Fallback.
- Tastaturbedienung des Icon-Grids und sichtbarer Fokus.
- responsive Header-Pruefung auf schmalem Mobile-Viewport und Desktop.
- Dark/Light Theme sowie deutsche und englische Texte.

## Risiken und Gegenmassnahmen

| Risiko | Gegenmassnahme |
| --- | --- |
| Zentraler Onboarding-State hat kritischen Blast Radius | Kein neuer Step/Status; Personalisierung bleibt optional im LanguageStep. |
| Bilddatei wird als Schad- oder Dekompressionslast missbraucht | fruehes Request-Limit, Magic Bytes, Pixel-Limit, Einzelbild, serverseitiges Re-Encoding. |
| Fremde User-Bilder werden erraten | Self-only Route ohne `userId`; Auth vor Dateizugriff. |
| Browser zeigt nach Wechsel ein altes Bild | monotone Revision in URL plus private Cache-Header. |
| Foto und Icon laufen auseinander | ein Service, per-User Lock, atomische Dateien, kompensierter DB-Update. |
| Profilfoto landet in DB/Session oder Logs | nur URL in `user.image`; Bytes ausschliesslich im `/data`-Dateisystem. |
| Header wird auf Mobile zu eng | Name responsiv kuerzen/ausblenden, Avatar und accessible Name beibehalten. |
| Bestehender `profile`-Begriff wird verwechselt | Code und Texte verwenden fuer den User `profile appearance`/`account identity`; Agent-Profil bleibt separat. |

## Nicht Teil von V1

- freie Avatar-Farben,
- frei waehlbare runde/eckige Form,
- interaktives Crop-/Zoom-UI,
- Gravatar oder externe Bild-URLs,
- Anzeige fremder Avatare in Collaboration, Admin- oder Member-Listen,
- Selbstbearbeitung des Anzeigenamens,
- automatische Moderation von Bildinhalten.

Diese Punkte koennen spaeter auf Basis desselben `UserAvatar`- und Profile-Service-Vertrags ergaenzt werden.
