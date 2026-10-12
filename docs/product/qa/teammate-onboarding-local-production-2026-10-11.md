# Teammate-Onboarding: lokaler Production-E2E-Test, 11.10.2026

Das Onboarding über einen manuell geteilten Einladungslink funktioniert: Ein neuer Mitarbeiter kann sein Passwort setzen, sich anmelden, das persönliche Onboarding abschließen und eine eigene Notiz erstellen und erneut öffnen. Ein vom Administrator direkt angelegter neuer Administrator kann denselben Einstieg abschließen und anschließend Benutzer verwalten.

Einladungs-E-Mails werden derzeit **nicht automatisch versendet**. Mailpit bestätigt, dass der konfigurierte SMTP-Versand funktioniert; der Einladungsablauf erzeugt ausschließlich einen kopierbaren Link. Zusätzlich wurden vier Fehler reproduziert: ausbleibende Seat-Reduzierung beim Offboarding, ein alter Link im erneut geöffneten Einladungsdialog, eine veraltete Seat-Anzeige und abgeschnittene Profiloptionen auf Mobilgeräten.

## Testumgebung und Nachweisgrenzen

| Eigenschaft | Getesteter Stand |
| --- | --- |
| Notebook-Quellstand | `64d837734b067661be761cff3512692743cb59ad`, Version `2026.10.10.1` |
| Notebook-Worktree | `/Users/frankalexanderweber/.codex/worktrees/teammate-onboarding-e2e/canvasstudios-notebook` |
| Control Plane | `cfa71334352ad51c0b2ab038ee8ee43ade82deda` |
| Production-Image | `sha256:8be193f99d3b9a0f8ad29b69a16a2edb48cb542f47ad0928b3011ffea1e0ad2c` |
| Verwalteter Stack | Notebook `127.0.0.1:3100`, CP API `4001`, CP UI `4004`, PostgreSQL `55433` |
| Datenbank | PostgreSQL `18.4`, pgvector `0.8.3`; persistente getrennte Notebook-/CP-Datenbanken |
| Lizenz | Community Team, `test` / `development`, `test_grant`, nicht abrechenbar; Freigabe bis vier Seats |
| Startzustand | Zwei aktive Nutzer, zwei lizenzierte Seats; gemeinsame Testumgebung mit vorhandener Historie |
| Browser | Playwright Chromium, getrennte Kontexte für Administrator, Mitarbeiter, neuen Administrator und anonyme Linkprüfung |
| Viewports | Desktop `1440 × 1000`, Mobilansicht `390 × 844` |
| SMTP-Sink | Mailpit `v1.31.4`, SMTP `127.0.0.1:1025`, UI `127.0.0.1:8025` |

Der Stack wurde aus dem Worktree neu gebaut. `npm run build` lief vor den Docker-Builds erfolgreich; anschließend waren Notebook, CP API, CP UI und PostgreSQL gesund. Es wurde ein verwalteter Stack verwendet. Mailpit war ein zusätzlicher SMTP-Testdienst mit ausschließlich lokalen Ports.

Beim Setup meldete das Startskript zunächst belegte Ports trotz vorhandenem verwaltetem Stack. Ein Stop/Start ausschließlich dieses Stacks unter Erhalt aller Daten ermöglichte den frischen Build. Ein zunächst verlinktes `node_modules` außerhalb des Worktrees wurde von Turbopack abgelehnt; eine lokale Kopie löste das Buildproblem. Beides sind Setup-Beobachtungen, keine Fehler des Benutzer-Onboardings.

Mailpit lief mit Authentifizierung und erforderlichem STARTTLS. Ein lokales Testzertifikat wurde über `NODE_EXTRA_CA_CERTS` vertraut; die TLS-Prüfung blieb aktiv. Das entspricht der [offiziellen Mailpit-SMTP-Konfiguration](https://mailpit.axllent.org/docs/configuration/smtp/). Bootstrap-Zugang und Testpasswörter blieben in privater Laufzeitkonfiguration. Links und Passwortfelder sind in Screenshots maskiert.

Dies ist ein Test der tatsächlichen lokalen Production-Container und Browseroberflächen. Die erstmalige Server-/Administrator-, Lizenz- und Provider-Einrichtung war bereits abgeschlossen; geprüft wurde das persönliche Onboarding eines neu angelegten Administrators. Stripe-Abrechnung, externe Mailzustellung, Managed-Team-Deployment, Safari/Firefox und physische Mobilgeräte wurden nicht geprüft. Die optionale Bradley-Profilunterhaltung wurde über „Set preferences later“ übersprungen; die Tour war in dieser Installation deaktiviert. Diese beiden optionalen Zweige sind keine bestätigten AI-/Tour-Funktionstests.

## Durchgeführter Ablauf

| Schritt | Tatsächlich geprüft | Ergebnis / Beleg |
| --- | --- | --- |
| Administrator anmelden | Bootstrap-Zugang über das Loginformular; Benutzerverwaltung öffnen | Erfolgreich. [Benutzerverwaltung](teammate-onboarding-2026-10-11/03-admin-user-management.png) |
| SMTP anschließen | System-E-Mail über Settings konfigurieren; Testmail senden; Empfänger und Inhalt in Mailpit prüfen | HTTP 200, Mail angekommen. [SMTP](teammate-onboarding-2026-10-11/04-system-email-configured.png), [Mailpit](teammate-onboarding-2026-10-11/05-mailpit-received-test.png) |
| Mitarbeiter einladen | Name/E-Mail eingeben, Einladung erstellen, Copy-Button und tatsächlichen Clipboard-Inhalt prüfen | HTTP 201, korrekter Link, sieben Tage Laufzeit. [Dialog](teammate-onboarding-2026-10-11/06-invitation-link-created.png) |
| Link als neuer Nutzer öffnen | Getrennter anonymer Browser; Desktop und Mobilansicht | Vorschau und primäre Aktion nutzbar. [Desktop](teammate-onboarding-2026-10-11/07-invitee-preview.png), [Mobil](teammate-onboarding-2026-10-11/08-invitee-preview-mobile.png) |
| Einladung annehmen | Annahme und Seat-Quote von zwei auf drei; Seite neu laden und Aktivierung fortsetzen | HTTP 202; Test-Quote automatisch freigegeben, 0 EUR. [Angenommen](teammate-onboarding-2026-10-11/09-invitee-accepted.png) |
| Passwort setzen | Zu kurzes Passwort ablehnen; gültiges selbst gewähltes Passwort aktivieren | Längenfehler sichtbar; anschließend HTTP 200, aktiver Account und signierter Seat. [Fehler](teammate-onboarding-2026-10-11/10-short-password-rejected.png), [Aktiv](teammate-onboarding-2026-10-11/11-invitation-active.png) |
| Erste Mitarbeiter-Anmeldung | Deutschsprachiges Loginformular; verpflichtendes persönliches Onboarding | Sprache, Workspace, optionale Präferenzen und Abschluss durchlaufen |
| Onboarding persistieren | Sprache auf Englisch setzen; Workspace-Schritt neu laden; später frische Anmeldung | Schritt bleibt erhalten; abgeschlossener Wizard wird bei frischer Anmeldung nicht erneut angezeigt. [Abschluss](teammate-onboarding-2026-10-11/18-new-member-onboarding-complete.png), [Home](teammate-onboarding-2026-10-11/19-new-member-home.png) |
| App tatsächlich benutzen | Persönliche Notiz über UI erstellen, Editor öffnen, Text schreiben, Autosave und Reload prüfen | Text bleibt gespeichert. [Editor](teammate-onboarding-2026-10-11/23-new-member-note-written.png), [Nach Reload](teammate-onboarding-2026-10-11/24-new-member-note-persisted.png) |
| Mitarbeiterrechte | Admin-Menü und System-E-Mail-API prüfen | Benutzerverwaltung ausgeblendet; Admin-API HTTP 403. [Settings](teammate-onboarding-2026-10-11/25-member-settings-no-admin.png) |
| Administrator direkt erstellen | Create user, Administratorrolle, Prepare account, Quote drei auf vier, Startpasswort, Activate user | Vorbereitung HTTP 202, Aktivierung HTTP 200. [Quote](teammate-onboarding-2026-10-11/26-admin-created-user-seat-quote.png), [Aktive Nutzer](teammate-onboarding-2026-10-11/27-admin-two-new-users-active.png) |
| Neuer Administrator | Separates Login, persönliches Onboarding in Mobilansicht, danach Benutzerverwaltung und Admin-API | Erfolgreich, Admin-API HTTP 200. [Workspace mobil](teammate-onboarding-2026-10-11/30-new-admin-workspace-mobile-ready.png), [Neue Admin-Sicht](teammate-onboarding-2026-10-11/31-new-admin-user-management.png) |
| Persönliche Daten trennen | Beide neuen Nutzer haben verschiedene persönliche Workspaces; neuer Administrator versucht Zugriff auf Mitarbeiter-Notiz | Fremde persönliche Notiz HTTP 404 ohne Zugriffsfreigabe |

Der Administrator muss bei einer Einladung den Link selbst weitergeben; der Eingeladene wählt sein eigenes Passwort. Bei „Create user“ setzt der Administrator dagegen das Startpasswort und gibt es nach Aktivierung separat weiter. Auch dieser zweite Ablauf erzeugt keine Zugangsdaten-E-Mail.

Mailpit enthielt am Ende **fünf** Nachrichten: eine System-Testmail und vier nachgeholte „Your team access is paused“-Benachrichtigungen für alte Testidentitäten. Für beide neu angelegten Nutzer kam keine Einladungs- oder Passwortmail an. Die vier historischen Benachrichtigungen dürfen nicht als erfolgreicher Einladungsversand gezählt werden. [Mailpit-Prüfwerte](teammate-onboarding-2026-10-11/mailpit-summary.json).

## Schutzfälle

| Prüfung | Ergebnis |
| --- | --- |
| Bereits verwendete Einladungs-E-Mail erneut einladen | HTTP 409, `INVITATION_ALREADY_USED`. [Beleg](teammate-onboarding-2026-10-11/33-duplicate-email-rejected.png) |
| Fünften Seat über Freigabe von vier hinaus anfordern | HTTP 409, `TEAM_SEAT_LIMIT_EXCEEDED`. [Beleg](teammate-onboarding-2026-10-11/35-seat-ceiling-error.png) |
| Nicht verwendete Einladung widerrufen und Link erneut öffnen | Widerruf HTTP 200; anonymer Link HTTP 410. [Beleg](teammate-onboarding-2026-10-11/36-revoked-link-rejected.png) |
| Ungültigen Token öffnen | HTTP 404, verständlicher Fehler. [Beleg](teammate-onboarding-2026-10-11/37-invalid-link-rejected.png) |
| Akzeptierte Einladung neu laden | Fortsetzung der Aktivierung funktioniert |
| Fertiges Onboarding in frischer Sitzung | App öffnet ohne erneuten Wizard |
| Mitglieder-/Admin-Berechtigungen | Mitarbeiter-Adminzugriff 403; neuer Administrator darf Verwaltung verwenden; persönliche Workspaces bleiben geschützt |

Während der Browserprüfung wurden keine JavaScript-`pageerror`-Ereignisse beobachtet. Erwartete 403/404/409/410-Antworten der Schutzfälle sind erfolgreiche Negativtests.

## Reproduzierte Fehler und Optimierungen

### P1 — Offboarding gibt lizenzierte Seats nicht frei

**Reproduktion:** Beide zuvor aktivierten Testnutzer nacheinander über Actions → Offboard einschließlich Preflight archivieren. Die UI meldet Erfolg und beide Accounts sind gesperrt. Anschließend `/api/license/status` und die neuen Seat-Outbox-Vorgänge prüfen.

**Beobachtung:** Vor dem Test `observed=2, licensed=2`; nach den beiden Aktivierungen `4/4`; nach Offboarding `observed=2, licensed=4`. Beide neuen `seat_prepare / member_remove`-Vorgänge enden mit `MEMBERSHIP_SEAT_RESPONSE_INVALID`. Auch ein erzwungener Snapshot-Abgleich mit HTTP 202 beseitigt den Drift nicht; der Status bleibt `support_required / observed_below_licensed`. [Archivierte Nutzer](teammate-onboarding-2026-10-11/40-test-identities-archived.png), [Seat-Zustand](teammate-onboarding-2026-10-11/42-offboarding-seat-reduction-stuck.png), [API-Prüfwerte](teammate-onboarding-2026-10-11/checks.json), [Outbox-Nachweis](teammate-onboarding-2026-10-11/seat-outbox-summary.json).

**Ursache aus dem Quellcode:** `offboarding.ts:925` entfernt zuerst die Mitgliedschaft und stellt die Reduzierung in die Queue. `team-membership.ts:691` fordert die neue beobachtete Anzahl an. Die allgemeine Antwortprüfung in `membership-orchestrator.ts:241` verlangt jedoch auch bei einer Reduzierung, dass `snapshot.observedQuantity` der bisherigen `quote.quantityBefore` entspricht. Bei einem legitimen Rückgang von vier auf drei bzw. zwei ist diese Gleichheit falsch. Der Worker speichert den Fehler als terminalen Fehlschlag.

**Auswirkung:** Der Zugang wird sicher entzogen, aber der Seat-Abgleich bleibt hängen. Die HTTP-200-/UI-Erfolgsmeldung bestätigt nur das lokale Offboarding. Sie bestätigt keine abgeschlossene Seat-Reduzierung. In diesem Test entstanden keine Kosten; die Auswirkung auf kommerzielle Abrechnung wurde nicht geprüft.

**Empfohlene Änderung:** Antwortvalidierung für `member_remove` an die bereits aktualisierte Snapshot-Anzahl anpassen und sowohl einzelne als auch kurz aufeinanderfolgende Offboardings mit veralteten Queue-Revisionen absichern. Die UI sollte den nachgelagerten Seat-Abgleich mit Pending-/Fehlerstatus anzeigen. Eine reine Zertifikatsaktualisierung korrigiert die Menge nicht.

### P2 — Nach „Done“ bleibt der alte Einladungslink erhalten

**Reproduktion:** Einladung erstellen → Done → Invite erneut öffnen.

**Beobachtung:** Der Dialog zeigt wieder den vorherigen, inzwischen aktivierten Link. Name und E-Mail für die nächste Einladung fehlen. Schließen über X oder vollständiger Reload setzt den Zustand zurück. [Beleg](teammate-onboarding-2026-10-11/32-invite-dialog-stale-link-on-reopen.png).

**Ursache:** `UserManagementPanel.tsx:1610` leert den Link im `onOpenChange(false)`-Handler; der Done-Button bei `:1683` ruft direkt `setInviteOpen(false)` auf. Beim erneuten Öffnen bleibt der alte Zustand bestehen.

**Empfohlene Änderung:** Gemeinsame Close-/Reset-Aktion für Done, Cancel, X und Escape verwenden. Wiederholtes Einladen sollte ohne Seitenreload funktionieren.

### P2 — Seat-Karte bleibt nach Aktivierungen veraltet

**Reproduktion:** Zwei neue Nutzer aktivieren, während die ursprüngliche Administrator-Verwaltung geöffnet bleibt; dort Reload verwenden.

**Beobachtung:** Vier aktive Nutzer stehen neben der alten Karte „2 / 2 Team seats used“. Die API meldet korrekt vier lizenzierte Seats. Die frisch geöffnete Verwaltung des neuen Administrators listet ebenfalls vier aktive Nutzer; die Seat-Gesundheitskarte ist dort aufgrund der Rollenberechtigung nicht sichtbar. [Veraltete Karte](teammate-onboarding-2026-10-11/34-stale-admin-seat-count.png), [Neue Admin-Nutzerliste](teammate-onboarding-2026-10-11/31-new-admin-user-management.png).

**Ursache:** `runAction` bei `UserManagementPanel.tsx:394` und Reload bei `:1093` laden nur Nutzer/Einladungen über `loadUsers`. `loadLicenseStatus` bei `:339` wird separat initial geladen, aber nach Mitgliedschaftsänderungen nicht aktualisiert.

**Empfohlene Änderung:** Lizenz- und Seat-Zustand nach Mitgliedschaftsaktionen sowie bei Reload mit aktualisieren.

### P2 — Optionaler Profil-Editor wird mobil abgeschnitten

**Reproduktion:** Sprache-Schritt des neuen Nutzers mit `390 × 844` öffnen und zu den Avatar-/Bildoptionen scrollen.

**Beobachtung:** Der Uploadtext wird fast Wort für Wort umgebrochen; rechter Rand des Uploadbereichs und vierte Icon-Spalte sind abgeschnitten. Die Seite selbst hat keinen horizontalen Scrollbalken, weil der Bereich den Überlauf versteckt. Continue bleibt erreichbar. [Beleg](teammate-onboarding-2026-10-11/29-new-admin-language-mobile-continue.png).

**Quellcode:** `ProfileAppearanceEditor.tsx:122` versteckt Überlauf; `:140` hat keine begrenzte minimale Breite; Upload-Flex bei `:153` bricht nicht um; `:195` verwendet auch auf schmalen Flächen vier Icon-Spalten.

**Empfohlene Änderung:** Kleine Breiten ausdrücklich unterstützen, Uploadaktion unter den Text legen und Icon-Spalten an die verfügbare Breite anpassen. Die umfangreiche optionale Darstellungsauswahl könnte erst nach dem Sprachschritt geöffnet werden.

### Produktlücke — Erwarteter Einladungsversand fehlt

Die SMTP-Verbindung ist funktionsfähig, wird für Einladungen jedoch nicht verwendet. `messages/de.json:4955` erklärt das ausdrücklich; `app/api/admin/organization/memberships/invitations/route.ts:126` gibt einen Acceptance-Link zurück und ruft keinen Versanddienst auf. Das ist derzeitiges Produktverhalten, kein reproduzierter SMTP-Fehler.

Falls „Teammate einladen“ den Mitarbeiter automatisch per E-Mail erreichen soll, fehlt dieser Schritt einschließlich Versandstatus und Wiederholungsmöglichkeit. Der gemeinsame Hinweis im Einladungsdialog fordert zudem zur Weitergabe eines Startpassworts auf, obwohl der Eingeladene in diesem Ablauf sein Passwort selbst setzt. Einladung und direkte Kontoanlage benötigen unterschiedliche Hinweise.

Weitere kleine Verbesserungen: Passwortlänge vor dem ersten Fehlversuch anzeigen; auf dem bereits aktiven Einladungsbildschirm den einleitenden Hinweis auf das noch gesperrte Konto aktualisieren.

## Aufräumen und Zustand der Umgebung

- Beide eigens angelegten Nutzer wurden archiviert; Sitzungen und Zugang wurden entzogen, persönliche Workspaces für Recovery gesperrt. Historie wurde erhalten.
- Die erstellte Testnotiz wurde über die reguläre Dateiaktion in den Papierkorb verschoben. Nicht verwendete Testeinladungen wurden widerrufen; die akzeptierte Einladung bleibt als Historie bestehen.
- System-SMTP wurde auf den vorherigen Zustand `configured=false`, `passwordConfigured=false`, `deliveryMode=local` zurückgesetzt. [Beleg](teammate-onboarding-2026-10-11/41-system-email-restored.png).
- Die Browser wurden geschlossen und der kopierte Testlink aus dem Clipboard entfernt.
- PostgreSQL und Datenverzeichnisse bleiben bestehen. Der verwaltete Stack bleibt für die abgestimmte parallele PostgreSQL-Prüfung verfügbar. Alte fehlgeschlagene Vorgänge wurden nicht gelöscht.
- Vorhandene Historie enthielt bereits 60 fehlgeschlagene Seat-Vorgänge und einen alten Pending-Vorgang. Nach diesem Lauf sind es 63: der erwartete Test oberhalb der Seat-Freigabe plus die zwei neu reproduzierten Reduktionsfehler. Der globale „attention“-Status allein war deshalb kein neuer Onboarding-Fehler.

Der lokale Seat-Zustand wurde anschließend über die bestehenden Community-Seat-Clients bereinigt: frische `member_remove`-Quote für vier auf zwei, `provider=test`, `environment=development`, `nonBillable=true`, bestätigte Freigabe und 0 EUR. Die Ausführung bestätigte `applied`, zwei effektive Seats und ein ausgestelltes Zertifikat. Zertifikatsrefresh und Snapshot-Abgleich bestätigten danach zwei aktive, zwei lizenzierte und zwei signierte Seats bei unveränderter Freigabe bis vier und `billedQuantity=0`. Der Abgleich ist wieder `in_sync`; die 63 historischen/neu fehlgeschlagenen Vorgänge bleiben erhalten. [Recovery-Nachweis](teammate-onboarding-2026-10-11/recovery.json).

Diese manuelle Bereinigung umgeht für den Test-Cleanup die fehlerhafte lokale Antwortprüfung über die bestehenden autorisierten Protokoll-Clients. Sie behebt den reproduzierten automatischen Reduktionsfehler nicht. Das exakte geprüfte Notebook-Image wurde wiederhergestellt und sein Health-Endpunkt antwortete erfolgreich.

## Belege

Die [Prüfwerte als JSON](teammate-onboarding-2026-10-11/checks.json) enthalten 32 einzelne Browser-/API-/Layoutprüfungen: 27 bestanden, vier reproduzierte Fehler und die Produktlücke beim Einladungsversand. Sie enthalten außerdem den Seat-Zustand vor, während und nach dem Ablauf. Die nummerierten PNGs liegen daneben. Übergangsbilder wie `15-new-member-workspace-mobile.png` zeigen noch Laden und dienen nicht als visuelle Abnahme; dafür wurde die stabile Mobilansicht `30` geprüft. Die vorübergehende leere E-Mail-Kachel erholte sich nach Refresh; dies wurde als Ladebeobachtung und nicht als dauerhafter Fehler eingeordnet.

Es wurden keine Anwendungssymbole geändert. Die empfohlenen Korrekturen sind offen; dieser Commit dokumentiert den Test und seine Ergebnisse.
