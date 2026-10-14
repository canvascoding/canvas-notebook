# Native Request: fehlgeschlagene Workspaceprüfung ist kein Zugriffsverbot

Status: **Enger Sourcefix abgeschlossen; Capture-/Join-Wirefix und neue Browserabnahme folgen getrennt.** Autorcommit `de0b4af0bdd2d631dbe7e5010ce369d76ed02a59` verändert zwei Produktdateien und die bestehende kontrollierte Sperrgegenprobe.

Die [echte Row-Lock-Gegenprobe](./yjs-native-peer-busy-counter-evidence.md) zeigte, dass ein Resolver-500 bisher als `PRINCIPAL_ACCESS_DENIED`/403 ausgegeben wurde. Nun unterscheiden die tatsächliche Principal-Factory und der davor liegende native Origin-Eingang ausschließlich diesen 500-Fall als `PRINCIPAL_WORKSPACE_UNCONFIRMED`. Der native HTTP-Statusmapper liefert dafür 503. Echte 401/403 und die bestehenden Busy-409-Verträge bleiben erhalten. Es wird kein Principal, Token, Consumer, Nativewrite oder Retry aus der fehlgeschlagenen Workspaceprüfung freigegeben.

Der allgemeine `requireSessionWorkspace`-/Organization-Bootstrapresolver und seine Schreibmechanik bleiben unverändert. Der Constructorbody der gemeinsamen Fehlerklasse bleibt ebenfalls bytegleich; seine Literaltypmenge erhält die neue Kennung. Die vollständige native B-Funktion einschließlich Locks, Zeitgrenzen, finaler Prüfung und Fehler-/Lifetimebehandlung bleibt bytegleich.

## Tatsächliche Prüfung

Der Autor bestätigt acht echte Source-/PG-/Netzwerkfamilien auf dem Fix. Darunter liegen drei getrennte HTTP-Gegenfälle: native B-Row-Busy und danach echte Factory-UPDATE-57014 ergibt 503 ohne Token; früher Origin-UPDATE-57014 ergibt 503 ohne Principal-B-Mint; drei Table-Busy-Bs ergeben weiterhin 409. Noch unveränderte Capture-/Join-Denials und Connected-/Message-1013-Verläufe bleiben in dieser Matrix ausdrücklich dokumentiert.

Zusätzlich bestehen zwei gezielt gefilterte bestehende Authfamilien mit echten Consumer-/Final-Busy-Grenzen, FinalWriteRevoke-403, unverändert gebundener Root/Customer/Searchpath-409 und Sessionwiderruf-401. Es wird kein vollständiger neuer Lauf dieser alten Suiten behauptet. Eigener Socket/HTTP-Host, UUID-Schema, DATA und alle 21 beobachteten B-/Holder-/Waiter-Backends sind geschlossen/entfernt; beide weiteren Authfixture-Prozesse und Gruppen sind ebenfalls beendet.

Root übernimmt exakt die drei finalen Autorbytes und bestätigt auf seiner integrierten Basis erneut **15/15 echte PG18-/Auth-/FS-Importwriterfamilien**, vollständiges TypeScript mit 8 GiB/`--incremental false` sowie scoped ESLint. Root extrahiert 32 alte Funktions-/Methodenkörper: nur Factory, Originbeobachtung und HTTP-Statusmapper ändern ihre Körper; Constructor und vollständige B-Funktion bleiben bytegleich. Der gesamte getrackte Produktdiff beschränkt sich auf diese beiden Dateien. Der Autor prüft zusätzlich siebzehn vollständige geschützte Module gegen seine Basis.

Root-Impact vor Übernahme: gemeinsame Fehlerklasse **CRITICAL**, 25 direkte/237 insgesamt betroffene Symbole und vier Module; Factory MEDIUM mit sieben direkten/13 insgesamt, Origin LOW mit einem direkten/zwei insgesamt, Statusmapper ohne indizierte Caller LOW. Der kritische Blast Radius wurde vor Übernahme gemeldet. Keine indizierten Prozesse bedeuten keine vollständige dynamische Route-/Socketabnahme.

Finale SHA-256: Principal `f8c55e22f6a83f6317ac9a1891f2c51249051f4fa6e0fb3359314eec88d0bbd0`; Service `ddb44c878cf828d5d37d67e6f9ded513f0a7f48b22d7a4dd3319d1460265c903`; Counter `1f201ec954bcb26d5278fc8bc972b9cebd3954761e3e41d079d3f36ebaac9065`.

Der nächste Socket-Schritt benötigt belegtes ROLLBACK/Close/Dispose, eine unveränderliche vollständige Originalscopebindung über frische Phasen und einen unterscheidbaren temporären Wirezustand. Unklarer COMMIT, Closefehler oder echter Widerruf erlauben keinen Retry. Globale Sessionaktivierung, erneute vollständige Browsermatrix und Native-Mobile-Geräteabnahme bleiben offen.
