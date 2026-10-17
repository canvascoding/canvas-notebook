# Ursprüngliche Produktionsdateien: erneuter Lesezugriff

Stand: 17. Oktober 2026. Die erneuerte Canvas-Notebook-Verbindung ist tatsächlich authentifiziert; fünf ausdrücklich freigegebene Workspaces sind erreichbar. Die Diagnose verwendet nur lesende MCP-Aufrufe. Es wurde keine Produktionsdatei verändert und keine Dateiaktion erneut ausgeführt.

## Aktuelle Beobachtung

Im persönlichen Workspace „Alex“ sind beide ursprünglich genannten Pfade vorhanden:

| Pfad | Größe im Dateibaum | Größe laut Leseantwort | Gelesene Quelle | SHA-256 der vollständigen Lesequelle |
| --- | ---: | ---: | --- | --- |
| `ek-fuchs-transkript.md` | 0 Byte | 22.135 Byte | `live_yjs` | `bfbafb5f8721ac68b382a417097f8a239c855bed489da6bd3143bd1095ebc380` |
| `test_core_bearbeitungsfeatures.md` | 7.787 Byte | 7.787 Byte | `live_yjs` | `7ec9cd8bd12f4e65622cd274338e5c31096af276fb22ab26395393c2eb6e51b1` |

`ek-fuchs-transkript.md` wird vollständig in zwei begrenzten Leseantworten mit Offset 0 und 12.000 gelesen. Beide liefern denselben vollständigen Quellenhash; die zweite endet ohne Fortsetzung. Zusammen enthalten sie 21.884 Zeichen. Das Testdokument wird vollständig mit 7.691 Zeichen und ohne Fortsetzung gelesen. Der eigentliche Dokumentinhalt wird nicht in dieses Repository kopiert.

Die aktuelle Beobachtung bestätigt, dass die leere Dateiprojektion des Transkripts nicht als leerer Dokumentinhalt behandelt werden darf. Der Leseweg kann den maßgeblichen Yjs-Inhalt liefern. Das stützt die zentrale Quellenautorität des Konsolidierungsplans.

## Grenzen und nächster Nachweis

Die ursprüngliche Meldung `PREVIEW_BLOCKED / uninspected-source` stammt aus einer Dateiaktion auf `test_core_bearbeitungsfeatures.md`, bei der `ek-fuchs-transkript.md` nicht geprüft werden konnte. Der jetzige erfolgreiche Lesezugriff reproduziert diese ursprüngliche Aktion nicht und beweist weder deren damalige konkrete Codec-/Exportursache noch eine heutige erfolgreiche Move-/Delete-Ausführung. Es wurden dafür keine neuen Produktionslogs oder Binärzustände gelesen.

Die lokale Umsetzung muss weiterhin Dateiaktionen samt eingehender Linkpflege aus der maßgeblichen Dokumentquelle abnehmen. Eine spätere Produktionsprüfung benötigt einen konkreten neuen Dateiaktionsauftrag; die ursprünglich blockierte Anfrage startet nicht von selbst. Dateiaktions-Undo und Review Center bleiben ausgeschaltet. Dieser Lesebeleg ist kein Produktionsrollout und kein Ersatz für die abschließende integrierte E2E-Abnahme.
