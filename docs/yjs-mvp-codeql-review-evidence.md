# M3: CodeQL-Review der beiden PR-Hinweise

Stand: 20. Oktober 2026. Gilt nur für die zwei konkreten Hinweise auf PR #176; übrige CI/Review und gemeinsame Build-/Browserabnahme bleiben offen.

## Öffentliche Client-ID ist kein Passwort

[Hinweis 248](https://github.com/canvascoding/canvas-notebook/security/code-scanning/248), `js/insufficient-password-hash`, zeigt auf `mcpActorId` in `app/lib/files/workspace-operation-copy-origin.ts`. Sein SHA-256 erzeugt einen stabilen Attributionsbezeichner aus einer öffentlichen OAuth-Client-ID. Die vollständige Client-ID bleibt separat im Origin erhalten und wird bei aktuellen Aufrufen verglichen. Der Origin ist ausdrücklich keine Autorisierung; die gemeldete Quelle ist die synthetische `copyMcpOriginFixture` im Test. Es wird kein Passwort verarbeitet. Ein Passwort-KDF wäre hier eine Änderung des historischen Identitätsvertrags.

Unabhängiger Quellenreview bestätigt den Fehlalarm. Der PR-bezogene Alarm (`refs/pull/176/head`) wurde am 20. Oktober um 01:45:21 UTC mit begründetem `false positive` geschlossen. Kein Produktcode und keine Hashformel wurden geändert. Die getrennte Reviewdiskussion wird erst nach Dokumentation als erledigt markiert.

## Gleichverteilte Zufallsauswahl im isolierten Testfixture

[Hinweis 249](https://github.com/canvascoding/canvas-notebook/security/code-scanning/249) findet tatsächlichen Modulo-Bias im sechsstelligen Kurzcode des `public-share-repository-postgres-test.ts`. Dieser Wert gehört ausschließlich zum eigenen PG18-Testschema; HTTP ist dort ausdrücklich verboten. Der eigentliche Produktgenerator verwendet bereits Rejection Sampling.

Eine Testzeile verwendet jetzt `crypto.randomInt(alphabet.length)` pro Zeichen. Alle 37 eigentlichen Fallkörper, Originaltoken, SQL-/Transaktions-/Kollisions-/Cleanupprüfungen bleiben bytegleich. GitNexus vor Edit: `candidate` LOW, ein direkter Aufrufer und keine Prozesse; `main` LOW, ein direkter Aufrufer und keine Prozesse.

Tatsächliche Root-Prüfung auf Basis `b4412a629615a3aef5f2e58a1199c1a70c65f27a`: Typen Exit 0 / 17,786 s, Lint Exit 0 / 1,892 s, vollständiger PG18-Test Exit 0 / 9,616 s, jeweils kein Signal. Alle 37 Gruppen bestehen; der Originaltest bestätigt entferntes eigenes Schema/DATA, null offene Clients, null HTTP und unveränderte übergeordnete Repositorytransaktion. Vollständiger Quellenvergleich vorher/nachher gleich. Kein zusätzlicher unabhängiger DB-/Prozesszensus wird aus diesem kurzen Lauf behauptet.

| Bindung | SHA-256 |
|---|---|
| `scripts/public-share-repository-postgres-test.ts` | `2019f5a2357b8e3ba88f73727057b031e2463052534e682d21f4c2b5081ba8ed` |
| `public-share-fixture/source-start.json` | `4d8e3c60b1204c44a6ae28071de7454bc675a007b26d807372ad8877b9df4868` |
| `public-share-fixture/terminal.json` | `524c7b75820075c70b822d3e9e2c6bed9c511a9275a20052925c88b274fdb597` |
| `public-share-fixture/public-share.log` | `d70b602706afbfc7ad0fedb9f14a80c402f3836148451aa3373c1a964bb84818` |

Private Originale unter `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m3-legacy-close-x5x_tco0`. Der erste zurückgewiesene Metadatenrequest wegen der 280-Zeichen-Grenze veränderte keinen Alarm; der anschließend bestätigte kurze Request ist unter `codeql-248-triage.json` erhalten.
