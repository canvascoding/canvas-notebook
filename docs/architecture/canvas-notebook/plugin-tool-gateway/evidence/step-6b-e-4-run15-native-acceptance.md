# 6b-e-4: vollständige native Abnahme Run15

Stand: 2026-10-11. **16/16 Plattform/Fall-Kombinationen und 96/96 Root-Prüfpunkte bestanden.** Der ursprüngliche Worker nahm den unveränderten formalen ACK an; der gesamte ursprüngliche Fixture-Lauf und die unabhängige Bereinigungsprüfung endeten jeweils mit Exit0. 6b-e-4 und 6b-e sind abgeschlossen. 6b-f und Plan7 bleiben offen.

## Ausführung und Quellen

- R15: /private/tmp/canvas-agent-settings-browser-PbWoI9
- C15: /private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-mobile-native-controller-run15-_aifsazq
- Nonce: 25eccccf1f09e527663db28d971ce44f. Keine Übernahme historischer oder fremder Flows.
- Notebook: ad015c17da9c2a6d268f73fbb5903814b688c68d; Mobile: 6e521b2079a0bd315008db0969e826884a3dd50e.
- Tatsächlich installierte Entwicklungsclients: iOS Build55 / Android Build17; eigener Simulator 539E8227-51F5-42CD-AD8E-0D39DE4E4098 und Emulator emulator-5588. Metro8086 blieb erhalten.
- Alle 65 ursprünglichen Whole-Launcher: Exit0, Gruppen geschlossen, identische 32 YAML-Quellen. Digest: 58d06ae6756bb1d11c00d20d00634d4396323a0d19df59b3fd3d1d07c17a7356.
- Originale einmalige Fixture-Frist 17:05:38Z eingehalten. Keine Verlängerung von OAuth-, Auth-, Lizenz- oder Retention-Grenzen.
- Das historische Schemalabel run12 in Collector/Eval benennt das eingefrorene Format. Tatsächliche Roots, Nonce, Quellen, Prozesse und Fälle sind ausschließlich Run15.

## Tatsächliche Fallmatrix

| Fall | iOS | Android | Geprüfter Inhalt |
| --- | --- | --- | --- |
| personal-v1 | bestanden | bestanden | Owner: persönliche V1-App, Reject/Allow und Wiederöffnung |
| scoped-resources | bestanden | bestanden | Org-/Team-Pakete, Store-V1→V2, Verantwortung und Use-only-Freigabe |
| shared-connections | bestanden | bestanden | Vier getrennte MCP-/Composio-Org-/Team-Referenzen |
| workflow-management | bestanden | bestanden | Veröffentlichte Pins, Skill-Lesewurzeln, feste/wählbare Bindungen |
| use-only-choice | bestanden | bestanden | Zweiter Nutzer: Team→Org, Präferenzrevision +2, zentrale Pins unverändert |
| shared-app-approval | bestanden | bestanden | Manager: Org-Reject0, Team-Allow1, ursprüngliche Auth-Sitzung |
| native-oauth-return | bestanden | bestanden | Echte Browserfreigabe, automatische Rückkehr, exakter Abschluss und Abbruch |
| identity-lifetime | bestanden | bestanden | Manager-Abmeldung, neuer Use-only-Nutzer, altes Widget/Quelle gesperrt |

Die 16 ausgewählten Originalfälle, getrennten Root-Reviews und Quellen-/Launcher-/Helper-Hashes stehen im finalen Eval-Input4 und Eval-Ergebnis. Der reine Descriptor-Assembler erzeugt keine Zustimmung: Root setzte die 96 Beobachtungen nach eigener UI-/Belegprüfung. Eval prüfte JUnit, ganze Launcher, ursprüngliche Sitzungen, aktuelle Serverrechte, Byte-Pins, zehn gültige Vorprüfungen und alle elf OAuth-Flows. Es kopierte 210 geprüfte Belege; der ACK enthält unverändert dessen legalen 16-Fall-Entwurf.

## Server- und Providerabgleich

- Alle elf ursprünglichen OAuth-Flows: neun completed, zwei cancelled. Genau ein originaler Commit pro erfolgreichem Flow, null Publikationen pro Abbruch. Keine ausgelassenen Flows.
- Android: sechs Flows (fünf completed/ein cancelled); iOS: fünf (vier completed/ein cancelled). Jeder reguläre positive Fall hat eine abgeschlossene Vorprüfung, tatsächliche Browserfreigabe und automatische App-Rückkehr ohne manuelles Schließen.
- Aktuelle Bindungsrevisionen: MCP Organisation2→5 (drei Publikationen), MCP Team2→4 (zwei), Composio Organisation1→3 und Team1→3 (je zwei). Metadaten-/Freigaberevisionen unverändert.
- MCP-OAuth-Provider: Consents7, Approvals5, TokenExchanges5, FailedTokenExchanges0.
- Kontrollierter Composio-Provider: vier SDK-Links, vier Approvals, vier Callback-Redirects, BusinessCalls0.
- MCP Apps: acht terminale Zeilen, vier rejected/vier completed; vier reale app_view-Dispatcheraufrufe und vier native app_action-Aufrufe. Wiederöffnung und Reject verursachen keine zusätzlichen Aktionen; model_only0. Finale Telemetrie: Requests125, ResourceReads24, VerificationProbes1.
- Beide Plattformen: tatsächlicher Store-Übergang1.0.0→2.0.0 am selben neuen resourceRef, Paketrevision +1, richtige Org-/Team-Installation. Keine Wiederholung einer bereits installierten Kandidatenmutation.
- Finaler Collector3: verified, SQLWrites/API/Decrypt0, READ ONLY Rollback bestätigt, Client freigegeben und Pool geschlossen.

## Bewahrte Fehler und Belegkorrekturen

Ein zusätzlicher Android-MCP-Org-Abschluss wurde vor Ende der Guard-Prüfung freigegeben; der Guard lieferte Exit1. Root bewahrte Original-Start/Finish/Flow/Commit und Screenshot, wiederholte anschließend einen neuen korrekt geprüften positiven Flow und zählt beide tatsächlichen Publikationen. Der Fehlversuch wird nicht als positiver Guard-Fall dargestellt.

Weitere Originalbelege bleiben unverändert: iOS-Controllerfehler vor dem ersten Kindprozess; Android-41-Fencefehler durch überlappende native Anmeldung desselben Testnutzers mit anschließend separat geprüftem neuen Before/41/After-Lauf; private Korrekturen vor der ersten Quellenverwendung; Android-Steuerungs-Timeout mit normaler UI-/OS-Wiederherstellung; Root-Observerfehler bei erwartetem pidof-Exit1.

Zwei Collector-Samples wurden vor Verwendung als letzter Abgleich durch zusätzliche server/discover-Telemetrie überholt. Vier Aktionen, acht App-Zeilen, ResourceReads und OAuth-Terminalfakten blieben gleich. Ein früher Eval lief korrekt mit Exit1/PNG aus: Root hatte originale CUA-JPEG-Bytes unter PNG-Dateinamen abgelegt. Bilder/Inputs/Reviews bleiben erhalten; der endgültige iOS-Fall verwendet bereits tatsächlich geprüfte originale Maestro-PNGs und unveränderte Root-Rückkehrereignisse. Keine Beobachtung, Quelldatei, Guard- oder PNG-Regel wurde abgeschwächt. **70 Originaldateien zu Fehlversuchen/Vorbereitungen sind im finalen preservedFailures gepinnt.**

## Reguläre und unabhängige Bereinigung

Beide Apps durch normale UI abgemeldet, mit Use another server getrennt, Serveradresse geleert und nur die eigenen App-Prozesse per OS beendet. Root prüfte die tatsächlichen Login-/Server-Eingabeflächen und Prozessabwesenheit.

- Original-Worker: native_verified_closed, outstandingnull, closedContexts/poolsClosed/seedersClosed/nativeAppClosedtrue; nativeEvidence16.
- Original-Parent und Issuer: cleaned, uncertainfalse, beide Datenbanken durch normalen Abschluss gelöscht; Issuer-App/Pools geschlossen, requestsInFlight0.
- Gesamter ursprünglicher Fixture-Lauf: ISOLATED_AGENT_SETTINGS_CLEANUP_PASS / Exit0. Keine Offline-Nachbereinigung zur Erzeugung dieses Erfolgs.
- Unabhängig bestätigt: eigene ursprüngliche fünf PIDs, vier eindeutige Prozessgruppen und fünf Listener abwesend; Notebook-/Issuer-Datenbanken und deren Sitzungen abwesend; DATA/TMP entfernt. Read-only-Abwesenheitsprüfung mit Rollback, freigegebenem Client/Pool, SQLWrites/API/Signals0.
- Nur die fünf eigenen Android-Reverses3001/64098/64093/64110/8086 und der eigene CDP-Forward64606 entfernt. Eigener Emulator/Metro und fremde Stacks/Geräte unverändert.

## Grenzen

Echte native Expo-UI, SDK-WebViews, OS-Browser, AuthSession-/Deep-Link-Rückkehr und gespeicherte Serververträge wurden mit kontrollierten lokalen Anbietern geprüft. Diese Abnahme ist kein natürlicher Modellworkflow, kein echter externer Canva-MCP-/Composio-Lauf, kein physisches Gerät und keine Produktions-/Releasefreigabe. Früherer echter Composio/Canva-Nachweis bleibt separat. 6b-f prüft als Nächstes den gemeinsamen Workflow mit zwei normalen Nutzern; Plan7 externe Zielaccounts und Rollout. Gateway weiterhin default-off; keine Container/Veröffentlichung. Separater strikter Mobile-Audit bleibt RED23HIGH/0CRITICAL.

Tatsächlicher Root-ACK: 2026-10-11T15:26:45.232Z.

## SHA-256 der endgültigen Belege

| Beleg | SHA-256 |
| --- | --- |
| R15/native-setup.json | c033beaec7e8cde7ee276ee39dbcbe91dbc1135b88c3c82143377312fe134a3f |
| R15/native-flow-observations.json | 31fd47a3a83185696dffb74a5fd8a3a7c4d7104952f0647a8157ca91db231f3d |
| R15/native-preack-sql-readback-run12-20261011152430870.json | 316e744281e6417a133706d4baca9b15cfbc05b2e2a916a919a4451ece7f251f |
| R15/root-native-final-semantic-review-r15-4.json | df6f9df3a3a24ac673618ed1c77a733802fc64ee77a1b355f272e79347900533 |
| R15/root-native-final-closure-r15-1.json | 7cef2d1261792330009686dd06c028f9a283b2a43334d9bd84b938c41921887a |
| R15/native-completion.json | fd83da702f18cf83fc6e2d5555cb6b451fa3d06f2d4d558eebca802591912f5a |
| R15/native-receipt.json | 49685983fb2a3368af285c653f394582dc6acdd29c29d6b0ff0dac28e3357305 |
| R15/recovery.json | ec22578232e1ca8a1e3ff215caaba334eb8a5e110b3ad69c0cf9f53435a279c9 |
| R15/issuer-recovery.json | b3560b7e183302eca50fb9ba8fb6b8b0b638ac1ef7b8373d47baf7589a4b6f8a |
| R15/native-mcp-oauth-provider-proof.json | 39c8c37ba8d72803ea2cc0a971bcb15b99848ea8769cc2a4df995d03a161255d |
| R15/native-composio-provider-proof.json | 4296f047d8f94bb3fff5ed37f47c9743b5e9f3377beb2de46771b96c5d684c4d |
| R15/native-package-provider-proof.json | 6c5b7f16380abe09c2e5d350b7f85eea54a63af4d52032a842f7ebfc65df478f |
| R15/mcp-app-provider-proof.json | fe7e3355cbbdd3b8725d73b2cb9b691f6ed91d23b41fa9f0cb1dc1fa493299f9 |
| R15/native-store-transition-ios-5-proof.json | 21299c3b14544eee51131848c4be98e578a873f1d98541d6d830b0bf3b5dfb29 |
| R15/native-store-transition-android-5-proof.json | 6e7b876a8457983693b975ef50af5f615666f09bb784202d95780cdd96a7f027 |
| C15/root-preack-input-final-r15-1.json | 8a512bfbdda26dcd9a50f12f38f280e7270c93b5d446259bfd8b4aa35943e05f |
| C15/root-native-final-evaluation-input-r15-4.json | e6a8e0b8921f65b6589a197336886ddb65b452f7689f8ac1e09b346797c52b05 |
| C15/native-final-case-evaluation-run12-5-draft-20261011152533090.json | 9e9e85ad21a48d604a7c22556d8b993be3649109c7bc8013b7edd53f89972c60 |
| C15/root-formal-ack-write-r15-1.json | cc5d43a9279346734be61b5afdb518dd1a1349bb2efaef0e89cc09cbb9e2ebd7 |
| C15/root-run15-independent-normal-cleanup-1.json | 857203f1f510503a58e16a7a3a7fb8e71fb0908819f2b3fff0193aa0fa85ddf8 |
| C15/root-owned-android-network-cleanup-r15-1.json | dd5a685bb98bf325e57330c4a4af6b753100b0f93ec30b9f19690baaf9c026f9 |
| C15/root-android-oauth-guard-order-failure-r15-1.json | c2e322e9466cf809fa0e46af4e75b50b62de15a40c6f6f766edb8cdd8f139821 |
| C15/root-native-eval-png-format-failure-r15-1.json | 0a58e0ebca6e8266fb0a85906c8ba9f52f5dcdc2e586a138a4f4b378ce3e7a42 |
| C15/root-preack-observation-race-r15-1.json | 59764546192ca8256b4a6bd04213c6d8232d9a7b68849275a53ee0673be90615 |
| C15/root-preack-observation-race-r15-2.json | ce9d3be0a37bed0252fc356e9bac97a0981233f98d718c68fd07ba0d99b4e09d |

## Gepinnte Ausführungs-Checkpoints

| Checkpoint | SHA-256 |
| --- | --- |
| C15/device-owner.json | a42c1f73166a128a88b35df17a8f6dd3b46fa4eb284e58e90eacd5bb088d6ff1 |
| C15/qa-inventory.json | 104871e335d7da6de1322b51fc82974b0a693b81ed09df010bcfd1a51e9eaf8a |
| C15/expected-root.json | b34e978a09f284ecc024b8d82762820706d42a3303aff7b1eba02f373e1596f8 |
| C15/root-source-freeze-2.json | 3b482887da4beac6c2476f7ad789818e1d01b65b315a2bf53351d2ca9157791e |
| C15/root-selected-source-rebind-4.json | bd583dab164d206ac8d3e28ee920655e49f08365a6f85ca77a94cf6c14024954 |
| C15/root-fresh-runtime-inputs-2.json | 06d2b001498b357e7ee6b1af409a5e8d1232d2ffdb88b27caae3910595f240ce |

Unveränderte finale Produzenten: Collector0405294d6216f4edb9d1c3210b82e0189032374fbc4a4b3c85d48f1ee87c7a43; Eval4081616fcf966939370b2225e1daad38561a838de142472e1fdbd9d3d594b7b8; Descriptor e23c7baff1c6d2d9a812626e53e6b865663e50bde8dc6cbb960af5c390e0ca54.
