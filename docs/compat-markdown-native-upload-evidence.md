# Kompatibler Markdown-Upload über den nativen Import

Stand: 17. Oktober 2026. Der Multipart-Endpunkt verwendet bei aktivem Native-Gate für `.md` und `.markdown` jetzt den vorhandenen Singlefile-Uploaddienst. Die allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus. Ein Produktionsrollout ist nicht erfolgt.

## Verhalten

`importCompatMarkdownUpload` übernimmt echte `File`-Bytes über die vorhandenen Schritte Session anlegen, Chunk schreiben und Datei abschließen. Der originale Request wird vor dem ersten Await getrennt aufgenommen; der bestehende Complete-/Importdienst prüft die tatsächliche Authentifizierung und installiert seine eigene Import-Lifetime. Der Adapter erzeugt keine eigene Schreibfreigabe und keinen direkten Markdown-Rohwrite.

Die Grenze beträgt 5 MiB je Markdown-Datei und wird vor dem Lesen des File-Inhalts geprüft. Das Multipart-Parsing selbst ist weiterhin ein gepufferter Transport. Leere Dateien überspringen den Chunk; der vorhandene Complete-Dienst erzeugt und synchronisiert die echte leere Quelle. Der Import bleibt Create-only. Gate-aus und andere Dateitypen behalten ihren bestehenden Pfad; Bildkonvertierung wird für native Markdown-Importe vor dem ersten Import abgewiesen.

Ein ausstehender nativer Abschluss liefert HTTP 202 und `success: false`, weil der bestehende Upload-Client `2xx + success: true` als vollständigen Abschluss behandelt. Die Antwort enthält die tatsächlichen Upload-/Datei-IDs und den Zielpfad. Nach unbestätigter Session-Erstellung wird ausdrücklich kein Locator erfunden. Ein nativer Fehler startet weder einen Rohwrite-Fallback noch eine automatische Löschung der Session.

Bei gemischten Batches bleiben bereits abgeschlossene Ergebnisse in der Eingabereihenfolge erhalten. Ein späterer Konvertierungs-, Schreib- oder Veröffentlichungsschaden verwirft die bekannten nativen Upload-Kennungen nicht. Der native Complete-Dienst besitzt seine Share-/Publish-/Auditeffekte; der Multipart-Endpunkt führt sie ausschließlich für bestätigte gewöhnliche Dateien aus. Begonnene Effekte werden innerhalb derselben Anfrage nicht erneut ausgeführt. Dies garantiert keine globale Exactly-once-Zustellung externer Effekte.

## Gezielte Prüfung und Grenzen

Die zwei neuen Programme `scripts/compat-markdown-upload-test.ts` und `scripts/compat-markdown-upload-route-test.ts` bestehen zusammen mit **35/35**, tatsächlichem Exit 0 und ohne Fehler, Skips oder abgebrochene Fälle. Sie führen die echten Helper-/Routenexporte mit echten File-/Request-/Streamobjekten und ausdrücklich ersetzten bestehenden I/O-Grenzen aus. Geprüft sind insbesondere leere und maximale Dateien, Größenablehnung vor Inhaltsread, echte Sessionkennungen und Bytes, Pending, verlorene Erstellung-/Chunk-/Complete-Antworten, gemischte Teilresultate und getrennte Effekte. Scoped ESLint und Diffprüfung bestehen.

Eine erste vollständige Typprüfung fand das fehlende Narrowing des optionalen Completionwerts. Der vorhandene unveränderte `never`-/Throw-Helper wurde dazu in eine Funktionsdeklaration überführt; die 35 Prüfungen und Lint bestehen danach erneut. Die abschließende vollständige cachefreie Projekt-Typprüfung besteht ebenfalls mit tatsächlichem Exit 0 und leerem Log (`/tmp/canvas-native-copy-metadata-tsc-5.log`); sie umfasst zusätzlich den separat entwickelten, noch nicht auf PostgreSQL abgenommenen Metadatenstand. Diese Adapterprogramme sind kein Datenbank-, Dateisystem-, Browser-, Build- oder Produktionsnachweis.

Privater Abschlussbericht nach der engen Typkorrektur: `/private/tmp/canvas-compat-markdown-tests-wm2djda1/typefix-results.json`, SHA-256 `3fc4419da507024c279f21f57e0d4cd1763681893a217a4decd2754c5dacef6a`. Frühere Originalberichte bleiben erhalten. Shared-Service, Kernel, Upload-Client und bestehende Testkörper wurden für diesen Adapter nicht verändert.

Vor der neuen integrierten Copy-Browserabnahme bleiben die gemeinsame Typ-/Datenbankprüfung, ein frischer QA-Build und der tatsächliche Multipart-Import mit anschließendem nativen Kopieren erforderlich. Die vorherigen Browserberichte gelten ausschließlich für ihre dort angegebenen älteren Codecommits.
