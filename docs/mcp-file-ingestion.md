# Vollständige Dateien über MCP speichern

Canvas bietet drei getrennte Eingabewege mit `knowledge:write`:

| Tool | Eingabe | Zweck |
| --- | --- | --- |
| `create_knowledge_source` | vollständiger UTF-8-Text | Neue Markdown- oder Textdatei direkt über MCP erstellen |
| `import_knowledge_file` | Host-Dateireferenz | Originaldatei oder Foto über eine temporäre HTTPS-Referenz übernehmen |
| `upload_knowledge_asset` | begin / Base64-chunk / complete | Binärdatei mit jedem MCP-Client übertragen, ohne Download-URL |

`create_knowledge_source` und `import_knowledge_file` müssen unter **Settings → MCP Server** ausdrücklich ausgewählt werden. Upgrades und die allgemeine Serveraktivierung schalten sie nicht automatisch ein. Zusätzlich sind Workspace-Opt-in, Freigabe für die konkrete OAuth-Verbindung und aktuelle Schreib-/Agentrechte erforderlich. Die Rechte werden unmittelbar vor der Veröffentlichung erneut geprüft.

## Host-Dateien

`import_knowledge_file` veröffentlicht `_meta["openai/fileParams"] = ["file"]`. Unterstützende OpenAI-Hosts ersetzen eine vom Nutzer ausgewählte oder erzeugte lokale Dateireferenz durch ein Objekt mit `download_url` und `file_id`; `mime_type` und `file_name` sind optional. Diese Umwandlung ist eine Host-Erweiterung, keine automatische Fähigkeit jedes MCP-Clients. Ein lokaler Pfad auf dem Client ist auf einem entfernten Canvas-Server nicht lesbar.

Die Referenz kann auf eine private Datei mit kurzlebiger signierter URL zeigen. Die Datei muss nicht öffentlich veröffentlicht werden. Canvas lädt sie mit HTTPS herunter und speichert sie im freigegebenen Workspace. Canvas-OAuth-Tokens und Browser-Cookies werden dabei niemals an den Dateihost weitergegeben. HTTPS, öffentliche Ziel-IP, DNS-Pinning, maximal drei Redirects, 30 Sekunden und 25 MiB werden serverseitig durchgesetzt. Jeder Redirect wird erneut geprüft. Der Download-Link und seine Zugangsdaten werden nicht im Importjournal gespeichert. Der Dateihost muss vom Canvas-Server aus erreichbar sein; eine eigene zusätzliche Header-Authentifizierung unterstützt dieser Adapter nicht.

Ohne diese Host-Erweiterung kann ein Client Text direkt übergeben oder Binärbytes in maximal 512-KiB-Chunks übertragen. Auch dafür ist kein öffentliches Hosting erforderlich.

## Neue Dateien und Wiederholungen

Beide neuen Tools verlangen `workspace_id`, `path` und einen stabilen `idempotency_key` (8–128 sichere Zeichen). Sie legen ausschließlich neue Dateien an. Zum Ändern bestehender Dokumente bleibt `edit_knowledge_source` mit seinen Revisions- und Review-Regeln zuständig.

Eine erfolgreiche Antwort enthält Pfad, Bytezahl, SHA-256, Revision, Operation und Editor-Link. Vor der Antwort wird die physische Datei geprüft. Private, atomar gespeicherte Importbelege überstehen einen Serverneustart. Ein identischer Retry liefert `already_created`, ohne die Datei erneut zu laden oder zu schreiben. Derselbe Schlüssel mit anderen Eingaben ist ein Konflikt. Bei Host-Dateien kann derselbe `file_id` mit einer erneuerten Download-URL wiederholt werden. Eine nachträglich geänderte oder entfernte Zieldatei wird nicht wiederhergestellt oder überschrieben.

Wenn ein Prozess zwischen Datei-Veröffentlichung und Speicherung des fertigen Belegs abstürzt, meldet ein Retry `MCP_INGEST_RECOVERY_REQUIRED`. Die Datei bleibt erhalten; vor weiteren Aktionen müssen Datei und Historie geprüft werden. Dies vermeidet eine falsche Erfolgsmeldung oder ein Überschreiben nach einem unklaren Ausgang.

## Markdown

- Text muss gültiges UTF-8 sein, darf kein NUL enthalten und ist auf 512 KiB begrenzt. Ungültige Unicode-Zeichen werden nicht stillschweigend ersetzt.
- Für erzeugtes Markdown verwendet Canvas denselben Metadatenparser und Rich-Markdown-Codec wie der Editor. Kaputtes YAML-Frontmatter, ein tatsächlicher Parserfehler und problematische lange Slash-Sequenzen werden abgelehnt.
- Hochgeladene Markdown-Originale behalten ihre Bytes einschließlich BOM, CRLF und abschließender Zeilenumbrüche. Frontmatter- und Editorprobleme liefern Warnungen; es erfolgt keine automatische Reparatur oder Normalisierung.
- `markdown.mode` meldet `rich`, `normalizable` oder `source`. Gültiges Markdown kann Quellmodus benötigen, etwa bei nicht unterstützter Obsidian-Syntax oder bei sehr großen Dokumenten. Das ist kein Datenverlust.
- Tabellenhinweise sind Diagnostik, keine pauschale Syntax-Sperre. Codebeispiele werden bei dieser Prüfung ausgenommen. Markdown erlaubt beispielsweise nicht geschlossene Code-Fences; eine Regex-Prüfung wäre dafür kein geeigneter Parser.

## Prüfung

`npm run test:mcp:file-ingest` führt gezielte Prüfungen für Schema, Berechtigungen, Downloads, Markdown, Speicherbelege und Opt-in durch. Teile davon ersetzen gezielt Netzwerk-/Datenbankgrenzen; sie beweisen keinen vollständigen Host-Upload.

`npm run test:mcp:file-ingest:e2e` verwendet den verwalteten lokalen PostgreSQL-Server, eine kurzlebige separate Datenbank und einen eigenen Notebook-Prozess. Der Test meldet echte OAuth-/MCP-, Dateisystem-, Editor- und Neustart-Ergebnisse getrennt. Eine reale ChatGPT-/Codex-Umwandlung lokaler Anhänge muss zusätzlich mit dem veröffentlichten bzw. verbundenen Tool geprüft werden.
