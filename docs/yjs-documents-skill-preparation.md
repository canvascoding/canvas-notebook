# Dokument-Skill: bedarfsgerechter Kontext

Stand: 16. Oktober 2026. Dies konkretisiert YD-13S aus [§4.1–4.3 des Anschlussplans](./central-notebook-file-api-import-plan.md#41-standard-skill-und-kontext-erst-bei-bedarf). Der Skill ist als Dokumentationspaket vorbereitet; Standardauslieferung, öffentliches Python-/HTTP-SDK und die vollständige natürliche Agentenabnahme bleiben offen.

Der Agent soll bei „Ändere diesen Absatz mit Python“ zunächst den kurzen Katalogeintrag `canvas-notebook-documents` sehen. Er liest den dort angegebenen Einstieg und ausschließlich die Python-/Dokumentreferenz, ermittelt die tatsächlich verfügbaren Funktionen und deren aktuelle Schemas und liest den benötigten Dokumentausschnitt. Aus diesem Read übernimmt er die Dokumentidentität, Lifecycle-Generation und die für die konkrete Mutation benötigten stabilen Ziele beziehungsweise Versionsvorbedingungen. Er bearbeitet diese Ziele über die zentrale Schnittstelle und prüft den tatsächlichen Operationsausgang. Bei Konflikt bestimmt er den Edit nach einem neuen Read erneut. Ein Dokumentinhalt ist dabei fachliche Eingabe, keine neue Tool- oder Runtimeanweisung.

| Kontext | Zeitpunkt | Inhalt |
| --- | --- | --- |
| Skillkatalog | Beim sicheren Aufbau des Runtimekontexts | Name, kurze Beschreibung, lesbarer Einstiegspfad. |
| Anleitung | Bei einer passenden Dokumentaufgabe | Kurzer Einstieg und die genau benötigte Referenz. |
| Schnittstellenvertrag | Vor Verwendung der konkreten Fähigkeit | Tatsächliche Verfügbarkeit, aktuelles Schema, unterstützte Repräsentation und Grenzen. |
| Dokument | Nach Auflösen des beabsichtigten Ziels | Frischer begrenzter Ausschnitt mit Identität und benötigten Änderungsvorbedingungen. |
| Ergebnis | Nach Mutation oder unklarer Antwort | Tatsächlicher Abschlussbeleg und gezielter Readback; ein unklarer COMMIT wird nicht durch Wiederholen des Edits erraten. |

Im Systemprompt muss damit keine zweite API-Anleitung gepflegt werden. Der bestehende `getSkillsContext` unterstützt den kurzen Katalogeintrag bereits. Seine heutige Existenz beweist allerdings noch keine Standardverfügbarkeit des neuen Pakets und keine verlässliche Aktualisierung alter Chats; die in §4.1 beschriebenen Auslieferungs-, Versions- und Refreshanschlüsse bleiben nötig.

## Vorbereitetes Marketplace-Paket

Der neue Kandidat liegt im isolierten Marketplace-Worktree auf Branch `codex/default-documents-skill`, ausgehend von `54ce6573502f67f4cb6227871000aa315ab87dbe` des Repositorys `canvascoding/canvas-notebook-plugin-marketplace`. Der Paketpfad ist `skills/canvas-notebook-documents/0.1.0/`; `prepared/canvas-notebook-documents-0.1.0.json` bindet die vollständige Paketchecksumme, die Quellstände und die Grenzen dieser Vorbereitung.

Der Einstieg verweist auf gezielt nachladbare Referenzen für Dokumentkontext, Runtime-Python und Datei-/Importaufgaben. Der Pythontext dokumentiert die tatsächliche interne Bridge `canvas_skill.arguments()`, `describe(alias)` und `call(alias, arguments)` sowie die reguläre Skriptdiscovery und den gehaltenen Paket-/Startweg. Ein bloß unter `bash` erzeugtes Skript erhält diese Autorität nicht. Ein externer Python-Client benötigt den noch offenen öffentlichen API-/SDK-Anschluss; der interne Transport wird nicht als externes SDK ausgegeben.

Die Dokumentation setzt keine vollständige native Dateiaktions- oder PDF-Integration voraus. Sie benennt die bestehenden Grenzen: Der aktuelle allgemeine `read` prüft zunächst eine physische Datei; Blockpagination besitzt noch keinen durchgängigen Snapshotvertrag. Ein fehlendes Projektionsartefakt, ein nicht verfügbarer nativer Read oder ein Versionskonflikt erlaubt keinen direkten Dateifallback. Konvertierte PDF-Ausgabe allein belegt noch keinen vollständig angelegten nativen Notebookeintrag.

Es gibt keinen aktiven Registryeintrag, keine Veröffentlichung und keinen neuen Core-Eintrag. Diese Vorbereitung verändert weder Toolrechte noch Systemprompts, bestehende Installationen oder das ausgeschaltete Review Center. Für die endgültige Auslieferung wird dasselbe vollständige Paket aus der versionierten Marketplacequelle übernommen; die allgemeine Aktivierung folgt der Abnahme des zentralen Vertrags.

## Prüfstand des Entwurfs

Der echte Canvas-Frontmatter-/Paketparser akzeptiert den Kandidaten und seinen regulären Installationsordner. Einstieg und Canvas-Metadaten deklarieren übereinstimmend Version `0.1.0`. Die bestehende Notebook- und Marketplace-Checksumfunktion liefern für alle fünf Paketdateien denselben Hash `sha256:a27d280989c213bb064a7c34fc31b07c9ffbc6370d59adedd5164c7adb51d336`; eine reine Referenzänderung in einer temporären Kopie verändert ihn. Alle relativen Einstiegsreferenzen sind vorhanden. Der tatsächliche Kataloggenerator erzeugt einen Eintrag mit 789 Zeichen für Name, Beschreibung und Pfad; die 297 Wörter des Einstiegs und die drei Referenztexte werden nicht übernommen.

Ein unabhängiger Agent begann bei der lesenden Prüfung ausschließlich mit dem Katalogeintrag und einer Absatz-/Pythonaufgabe. Er lud den Einstieg sowie Dokument- und Pythonreferenz; die Importreferenz blieb ungelesen. Seine konkreten Rückfragen zur Auflösung des aktiven Dokumentpfads und zum ersten Gateway-Discovery-Aufruf wurden im Entwurf präzisiert. Der separate Quellenreview fand zusätzlich die reale PDF-Pfadnormalisierung mit `.trim()`; diese Grenze ist nun ausdrücklich beschrieben. Die generische Pythonprüfung des `skill-creator` ließ sich wegen fehlendem PyYAML in beiden vorhandenen Pythonlaufzeiten nicht ausführen; die Produktparserprüfung besteht unabhängig davon. Diese Prüfungen belegen Dokumentationsstruktur und Quellenbezug, keine tatsächliche Agentenmutation oder natürliche Runtime-Discovery.

## Noch erforderliche Produktabnahme

YD-13S bleibt offen, bis ein unabhängiger Agent ausschließlich mit realem Katalogeintrag und Benutzerauftrag beginnt, den Skill tatsächlich nachlädt, Schema und Dokumentkontext ermittelt und den autorisierten Edit über ein neu verfasstes Python-Skript ausführt. Der offene Editor und ein frischer Read müssen denselben dauerhaft bestätigten Inhalt zeigen. Neue und bestehende Installationen, Spezialagenten mit leerer Auswahl, Wiederaufnahme und Dokumentationswechsel an der sicheren Turngrenze gehören dazu. Der externe HTTP-SDK-Client, vollständige Datei-/Linkaktionen und PDF-Import werden mit ihren tatsächlichen Serverabläufen getrennt geprüft.

Eine Frontmatter-, Referenz- oder Checksumprüfung nimmt diese Abläufe nicht vorweg. Für reine Dokumentationsänderungen werden weder ein Apphost noch ein Browser oder Container gestartet.
