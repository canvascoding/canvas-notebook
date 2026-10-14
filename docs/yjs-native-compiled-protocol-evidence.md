# Frischer kompilierter Mobile-Protokollnachweis

Stand: 14. Oktober 2026. **Abgeschlossen: ein tatsächlicher kompilierter HTTP-/WebSocket-Protokollfall.** Die gemeinsame Editor-/Import-Browserabnahme bleibt offen.

## Geprüfter Stand

Der eigene verwaltete QA-Worktree `yjs-compiled-admission` basiert exakt auf Notebook `e98c95770379eb089dcf579f4fd01b7872b3f13c`. Sein Commit `620ee1fb296bf092ec547a1a2d28312b70b35ef0` aktiviert ausschließlich das vorhandene native Textsessiongate. Im Integrationsworktree bleibt dieses Gate `false`. Der Control-Plane-Stand ist unverändert `27c8ce37da082244f006ca376068cde6b98845d5`.

| Beleg | Tatsächlicher Wert |
| --- | --- |
| Source-Fingerprint | `c14b50269b52aa667fd78cf272e35550b256b4e6f6390ccdde059544c10f8fdf` |
| Artefakt-Fingerprint | `1e5c0f6b0c4436da223d3151af4eb6a07cffa28e8c68bc68b1490f12aaf06cb6` |
| Build-ID | `build-TfctsWXpff2fKS` |
| Privater Gesamtbeleg SHA-256 | `a349308369b9934a0c1d7e65c11ca7bcec44c2596399e091f8cafa052138e20a` |
| Unabhängiger Rootbeleg SHA-256 | `d37e981070ead3b2322d744b35f850eabc18c5a9c9f6bd62ee4827745104548d` |

Die Build-ID stimmt mit einem älteren QA-Build überein und identifiziert das Artefakt daher nicht allein. Maßgeblich sind Commit und beide neu abgeleiteten Fingerprints. Root hat die originale `assertBuildProof` vor und nach dem Protokolllauf selbst erfolgreich ausgeführt; beide Ergebnisse stimmen überein.

## Tatsächlicher Buildverlauf

Ein erster CLI-Aufruf scheiterte vor jedem npm-Build an der fehlenden `react-server`-Bedingung. Der anschließende erste echte Build kompilierte und bestand TypeScript, wurde aber während der Seitendatenerfassung vom unveränderten Zwölf-Minuten-Guard beendet. Dieser Lauf bleibt als fehlgeschlagen erhalten.

Genau ein weiterer originaler Build mit unverändertem Source, unveränderten Guards und dem tatsächlich entstandenen Cache bestand vollständig: Kompilierung 59 Sekunden, TypeScript 27,8 Sekunden und 380 statische Seiten. Es gab zwei tatsächliche npm-Buildstarts. Abhängigkeiten und Lockfiles wurden nicht verändert; kein Container wurde gebaut oder gestartet.

## Tatsächlicher Protokolllauf

Der eingefrorene private Supervisor behält die originalen Ownership-, Zeit-, Abbruch-, Prozess- und Cleanupgrenzen. Gegenüber dem Original wurden fünf Importe auf denselben QA-Worktree gebunden und ausschließlich die Browser-Spec-Schleife durch den bereits geprüften einzelnen Protokollfall ersetzt. Root hat diese Transformation unabhängig zurückgeprüft. Alte fehlgeschlagene Fixtures und Belege bleiben unverändert.

Eine neue private Fixture mit Nonce `b1176e276c31b500a425ee2f0771d053` führte genau einen Lauf ohne Request-Retries aus:

1. Tatsächliche Anmeldung; Web-Setup ausschließlich mit dem ausgestellten Cookie.
2. Neues UUID-Ziel über den echten exklusiven Create-Weg und native Initialisierung.
3. Mobile-POST ausschließlich mit dem tatsächlich ausgestellten Bearer, ohne Cookie.
4. Raw-WebSocket ausschließlich mit dem ausgestellten Einmalticket; native Identität sowie tatsächlicher Inhalt und StateProof synchronisiert.
5. Socket geschlossen, dasselbe Ticket noch vor dessen Ablauf erneut verwendet und abgewiesen; anschließende Raumfreigabe bestätigt.

Alle fünf HTTP-Antworten sind `200`. Der ursprüngliche Supervisor schließt mit Exit `0`. Der Fall benutzt die bestehenden Create-/Initialisierungswege; er prüft nicht den noch offenen neuen Chunkimport oder dessen UI.

## Abschluss und Beweisgrenzen

Notebook- und Issuer-Recoverybeleg melden bestätigten Abschluss, geschlossene Pools, entfernte eigene Datenbanken und entfernte eigene DATA. Root hat zusätzlich alle sechs bekannten Prozesse, alle drei eigenen Prozessgruppen und den Loopbacklistener als abwesend geprüft. Eine unabhängige lesende Maintenance-Abfrage bestätigt null eigene Datenbanken und null eigene Datenbanksitzungen. Der Runtime-Lock ist entfernt. QA-Checkout, 21 geschützte Originaldateien und alte Belege bleiben unverändert.

Die privaten Belege liegen unter:

- `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-compiled-admission-preparation-23f2zfbi/final-compiled-mobile-protocol-evidence.json`
- `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-compiled-mobile-root-1p9kjxyi/root-evidence.json`

Root hat den Gesamtbeleg und alle 16 darin eingefrorenen Dateien anhand ihrer tatsächlichen Bytes geprüft. Dieser Abschluss belegt den kompilierten Serververtrag über die bisher fehlerhafte Modulkopiengrenze. Gemeinsame Browserinteraktion, Native-Mobile-Oberfläche, physische Geräte und Produktion sind gesonderte Abnahmen.
