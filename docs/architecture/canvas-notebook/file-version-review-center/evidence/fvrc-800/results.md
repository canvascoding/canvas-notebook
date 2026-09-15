# FVRC-800 Notification-source evidence

Datum: 15. September 2026

## Ergebnis

FVRC-800 fuehrt den datenminimierten Typ `file.change_review_required` als abgeleitete, aktionsbeduerftige Notification-Quelle ein. Das Target besteht ausschliesslich aus `workspaceId`, `lineageId` und `operationId`. Inhalte, Dateipfade, absolute oder fremde Pfade, Grants und Tokens werden weder gespeichert noch im Inbox-Vertrag ausgegeben.

Die Quelle leitet ihren Zustand aus den autoritativen Collaboration-Agentenoperationen ab. Aktionsbeduerftig sind `needs_review`, `semantic_conflict`, `partially_applied` mit Ausnahme des reinen Durability-Falls `persistence_degraded` sowie fehlgeschlagene `apply`-Operationen im angeforderten Modus `direct_apply`. Erfolgreiche Direktanwendungen erzeugen keinen ungelesenen Eintrag. Eine erfolgreich persistierte oder gecheckpointete Superseder-Operation loest auch eine nicht nachtraeglich umgeschriebene Ausgangsoperation auf.

## Autorisierung und Zustandsmodell

Ein Eintrag ist nur sichtbar, wenn der Workspace aktiv ist, der Nutzer lesen und schreiben darf und entweder selbst Initiator der Operation ist oder den Workspace verwalten darf. Read-only-Zugriff, fremde Workspaces, verlorene Berechtigungen und archivierte Workspaces ergeben Not-found beziehungsweise keinen Eintrag, ohne Titel, Pfad oder Inhalt offenzulegen.

Die Quelle verwendet `mobile_inbox_read_states` mit einem nutzer- und workspacegebundenen Schluessel je Agentenoperation. Ohne gespeicherten Zustand bleibt eine noch aktionsbeduerftige Review unabhaengig vom Alter ungelesen. Dismiss versteckt nur den aktuellen autoritativen Stand; ein spaeteres `updated_at` reaktiviert die Operation ungelesen. Mark-all verarbeitet nur sichtbare Eintraege und hebt eine aktuelle Dismiss-Entscheidung nicht auf. Sobald der autoritative Zustand nicht mehr aktionsbeduerftig ist, verschwindet die Notification automatisch.

## Kompatibilitaet und Rollout

Desktop-Summary integriert die Quelle genau einmal. Mobile Single-, Aggregate-, Filter-, Kategorie- und Badge-Vertraege nehmen File-Change-Eintraege nur nach explizitem Query-Opt-in `capability=inbox.file_changes.v1` auf; der Bootstrap kuendigt diese Capability an. Dadurch erhalten bestehende native Clients mit strengem Target-Parser weiterhin ausschließlich den Legacy-Vertrag. Hintergrund- und Push-Zaehler ohne Opt-in bleiben unveraendert.

Die Source-, Count- und Mutationspfade sind an den bestehenden File-Version-Center-Rollout gekoppelt. Notifications sind nur im Modus `full` aktiv; `off`, `shadow` und `read_only` liefern weder File-Change-Eintraege noch mutierbare File-Change-States. Alle anderen Rollout-Entscheidungen bleiben unveraendert.

FVRC-800 verwendet fuer Desktop und Home nur den sicheren generischen `/notebook`-Fallback und das generische Workflow-Icon. Beide Einstiege markieren File-Change-Notifications vor dieser Navigation bewusst nicht als gelesen. Exaktes Center-Open, eigene Statuscopy, Deep Links und Mark-read erst nach erfolgreichem Oeffnen bleiben FVRC-801.

## Verifikation

- `npm run test:file-version-center:notifications`: Source-, Deduplizierungs-, Permission-, Resolution-, Dismiss-/Read-State-, Kompatibilitaets-, Bootstrap- und Home-Regressionen bestanden.
- Policy- und Rollout-Fokustests bestaetigten `notifications: mode === 'full'` und unveraenderte restliche Flags.
- Changed-file ESLint und `npx tsc --noEmit --pretty false` bestanden.
- Ein echter Smoke gegen den einzelnen verwalteten lokalen Team-Seat-Produktionsstack mit PostgreSQL bestaetigte Desktop-Summary, Mobile Single/Aggregate, `notifications`/`all`/`unread`-Filter, Ausschluss aus `automation`, Kategorien, Badge, Legacy-Isolation und alle drei PATCH-Pfade. Dismiss/Reaktivierung und vollstaendige Wiederherstellung der vorherigen Datenbankzustaende wurden ebenfalls geprueft.
- Der verwaltete Host-Build, Docker-Image-Build, Notebook-Recreate, Bootstrap-Login, Fixture-Bootstrap und Healthcheck bestanden. Der bekannte, ausserhalb FVRC-800 liegende Build-time-Prerender-Baselinefehler der Sign-up-Seite erforderte dabei ausschliesslich fuer die Build-Verifikation den bereits dokumentierten temporaeren `force-dynamic`-Workaround; er ist nicht Bestandteil des Changesets.

## Bewusst nach FVRC-801 verschoben

- Der Query-Service des Review-Centers muss die exakte Auswahl fehlgeschlagener Direct-apply-Operationen fuer die Timeline ergaenzen.
- Desktop, Home und Mobile sollen erst nach erfolgreichem Oeffnen der exakten Operation als gelesen markieren.
- Eigenes Icon, spezifische Statuscopy und Deep-Link-/Workspace-Wechselverhalten werden zusammen mit dem globalen Center-Einstieg umgesetzt.
