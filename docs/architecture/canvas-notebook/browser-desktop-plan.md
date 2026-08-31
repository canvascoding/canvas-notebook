# Canvas Notebook Browser Desktop Plan

> Stand: 2026-08-15
> Status: Entwurf - noch nicht zur Umsetzung freigegeben

## 1. Ziel und Abgrenzung

Canvas Notebook soll optional neben dem bestehenden Agenten-Browser einen persoenlichen, manuell bedienbaren grafischen Linux-Browser anbieten. Der Nutzer sieht einen normalen Desktop im Canvas-UI und bedient Chromium ausschliesslich ueber Bild, Maus und Tastatur.

Der Dienst ist fuer normale, persistente Browsernutzung gedacht, etwa den manuellen Abruf von Web-Inhalten und Account-Ansichten. Er ist kein Ersatz fuer offizielle APIs und kein Mechanismus zum Umgehen von Zugriffs-, Challenge- oder Anti-Bot-Policies einer Website.

Nicht Teil dieser Planung sind:

- Fingerprint-Spoofing, Header-Manipulation, Proxy-Rotation oder Challenge-Manipulation.
- Zugriff von Canvas Notebook auf den Docker-Socket oder beliebige Host-Shell-Kommandos.
- ein allgemein privilegierter Remote-Desktop mit Zugriff auf Host-Dateisystem, Host-Netzwerk oder Docker.
- Ersatz des bestehenden Agenten-Browser-Tools.

## 2. Ausgangslage

Der aktuelle interaktive Browser laeuft im `canvas-notebook`-Container selbst:

```text
Canvas Browser Lab UI
        |
        | /ws/browser
        v
canvas-notebook Container
  - Next.js / Custom Node Server
  - Puppeteer Runtime
  - Chromium-Kindprozess mit --headless=new
        |
        v
Docker-Bridge-Netzwerk -> VPS-Egress
```

Chromium wird ueber `puppeteer-core` gestartet. In einem Docker-Runtime-Modus setzt die Launch-Logik den Headless-Modus. Das Profil liegt persistent unter `/data/cache/browser-runtime/{profileKey}` und ist aktuell je User, Agent und Workspace abgegrenzt; der Browserprozess selbst wird nach Leerlauf geschlossen.

Dieser Pfad bleibt fuer Agenten-Interaktion, Browser-Tooling und browserbasierte Exporte erhalten. Er darf nicht in einen allgemeinen Desktop-Dienst umgewandelt werden.

## 3. Zielarchitektur

Der grafische Browser ist ein separater optionaler Compose-Service auf derselben VM, nicht ein separater VPS:

```text
                         internes Docker-Netzwerk
Canvas Notebook ------------------------------------> browser-desktop
  - lokale Canvas-Session                              - grafische Linux-Sitzung
  - kurzlebiges, usergebundenes Ticket                 - schlanker Window Manager
  - HTTP-/WebSocket-Auth-Proxy                         - Chromium ohne Headless-Flag
                                                        - VNC/KasmVNC oder gleichwertiges
                                                        - persistentes Profil pro User
```

Die Desktop-Ansicht wird nur ueber eine Canvas-authentifizierte, gleichoriginige HTTP-/WebSocket-Route ausgeliefert. Der VNC-/Streaming-Port darf nicht am oeffentlichen Host-Port veroeffentlicht werden. Canvas validiert das Ticket, bevor es die Verbindung zum internen Dienst aufbaut.

Canvas greift nicht mit Puppeteer, DevTools oder einer Automationsschnittstelle auf den persoenlichen Desktop-Browser zu. Die Browserinteraktion bleibt eine manuelle Remote-Desktop-Sitzung.

## 4. Profil, Identitaet und Daten

- Ein Browserprofil gehoert mindestens zu `userId`; bei Team-Instanzen muss es zusaetzlich vom Workspace oder einer ausdruecklichen persoenlichen Browser-Identitaet abgegrenzt sein.
- Cookies, Local Storage, Downloads und Browser-Einstellungen liegen in einem eigenen persistenten Volume, zum Beispiel unter `/data/browser-desktop/users/{userId}`.
- Profile duerfen nicht zwischen Nutzern geteilt werden. Ein Nutzer darf keine anderen Profilpfade, Downloads oder Desktop-Sitzungen oeffnen.
- Der Dienst erhaelt nur die fuer die Desktop-Sitzung benoetigten Daten-Volumes. Keine Host-Mounts, keine Docker-Socket-Mounts und keine Secrets anderer Nutzer.
- Die Canvas-Session bleibt die Autoritaet. View-Tickets sind kurzlebig, enthalten Nutzer- und Sitzungsbindung und werden bei Logout, Rechteverlust oder Workspace-Wechsel widerrufen.

## 5. Netzwerk und Egress

Der grafische Browser verwendet zunaechst den normalen Egress des Hosts. Eine optionale Tailscale-Exit-Node-Konfiguration kann den Ausstiegspunkt auf das Heimnetz legen. Sie ist eine Netzwerkentscheidung und veraendert weder die Browser-Implementierung noch garantiert sie den Zugang zu einer bestimmten Website.

Die Reihenfolge fuer die Einfuehrung ist verbindlich:

1. Heimnetz-Egress separat pruefen.
2. Den bestehenden persistenten Browser manuell pruefen.
3. Den grafischen Desktop-Dienst nur dann einfuehren, wenn die normale manuelle Browserumgebung weiterhin erforderlich ist.

Wenn spaeter nur der Desktop-Browser einen gesonderten Egress erhalten soll, muss dies als eigener Netzwerk-Namespace bzw. dedizierter Gateway-Pfad fuer `browser-desktop` umgesetzt werden. Der Canvas-App-Container darf dadurch nicht unbeabsichtigt umgeroutet werden.

## 6. Lifecycle und Betriebsmodelle

### 6.1 Gemeinsame Compose-Verantwortung

`browser-desktop` ist ein weiterer Service der produktiven Canvas-Compose-Konfiguration. Er bekommt einen Healthcheck, definierte CPU-/RAM-Grenzen, ein persistentes Profil-Volume und einen klaren Versions-Tag. Das Canvas-UI steuert nie Docker direkt.

Die Host-CLI ist fuer administrative Containeraktionen zustaendig:

```text
canvas-notebook start | stop | restart | status | health | logs
```

Ein spaeterer, optionaler Unterbefehl wie `canvas-notebook browser-desktop status` oder `... restart` darf ausschliesslich eng begrenzte, deklarierte Compose-Aktionen ausfuehren.

Vor jedem Build eines Container-Images muss `npm run build` erfolgreich sein. Test-Container werden nie parallel betrieben und bei jedem Lauf frisch aufgebaut.

### 6.2 Managed-Installationen

Bei Managed-VMs kann der vorhandene Canvas Host Agent die eng begrenzten CLI-Aktionen fuer Health, Restart und optionales Start-on-Demand ausfuehren. Er bleibt ein technischer Verwaltungsdienst; Bild, Maus und Tastatur fliessen nicht durch den Agenten.

### 6.3 Self-Hosted-Installationen

Self-Hosted-Installationen haben keinen Canvas Host Agent. Die erste Version darf deshalb keinen solchen Host-Dienst voraussetzen:

- Der `browser-desktop`-Dienst bleibt als Compose-Service verfuegbar.
- Bei Inaktivitaet beendet ein Dienst-internes Idle-Management Chromium bzw. die Desktop-Sitzung; das persistente Profil bleibt erhalten.
- Start, Stop, Restart, Update, Status und Logs des Containers bleiben Administratoraufgaben ueber die lokale CLI oder Docker Compose.

Ein vollstaendiges automatisches Starten und Stoppen des Containers ist nur eine spaetere optionale Optimierung. Es verlangt bei Self-Hosted einen separat installierten, lokal beschraenkten Supervisor mit expliziter Authentisierung und einer Allowlist fester Lifecycle-Aktionen. Weder die App noch der Browser-Container bekommen dafuer Docker-Socket-Zugriff.

## 7. Ressourcen und Idle-Policy

Der Container wird durch CPU- und Speicherlimits von Canvas Notebook und Postgres abgegrenzt. Als erster Planungsrichtwert fuer eine aktive Einzel-Desktop-Sitzung gelten maximal etwa 1,5 vCPU und 2 GiB RAM; die konkrete Vorgabe wird vor dem Release auf Referenz-VMs gemessen und nicht nur aus Konfiguration abgeleitet.

Die Idle-Policy hat zwei Stufen:

1. Nach kurzer Inaktivitaet, zum Beispiel 5 bis 10 Minuten ohne aktive Desktop-Verbindung, wird Chromium geschlossen. Cookies und das Profil bleiben persistent.
2. Nach laengerer Inaktivitaet kann die Desktop-Sitzung beendet werden. Ein vollstaendliches Container-Stoppen ist in V1 nicht erforderlich und bleibt der optionalen Host-Supervisor-Erweiterung vorbehalten.

Eine Einzel-User-Referenzinstallation mit Canvas Notebook, Postgres und aktivem Browser-Desktop soll mindestens 4 vCPU, 8 GiB RAM und ausreichend SSD-Kapazitaet fuer Images, Canvas-Daten und Browserprofile einplanen. Ein GPU-Passthrough ist fuer normale Browser- und Office-Nutzung nicht erforderlich.

## 8. Phasen und Abnahme

### P1: Dienst und Isolation

- Eigenes `browser-desktop`-Image mit schlankem grafischen Linux-Desktop, Chromium, Streamingserver und Health-Endpunkt erstellen.
- Produktions-Compose um den optionalen Dienst, interne Netzwerkanbindung, persistente Profile und harte Ressourcenlimits erweitern.
- Keine oeffentliche VNC-/noVNC-Portfreigabe.
- Statische Sicherheits- und Build-Pruefungen ausfuehren; vor dem Container-Build `npm run build` ausfuehren.

### P2: Canvas-Auth-Proxy und manuelle View

- User- und sitzungsgebundene, kurzlebige Desktop-View-Tickets definieren.
- Gleichoriginige HTTP-/WebSocket-Proxy-Route im Custom Server implementieren.
- Browser-Desktop im Canvas-UI als separaten manuellen Modus ausweisen.
- Rechteverlust, Logout, Ticketablauf, konkurrierende Verbindungen und fehlender Dienst muessen sichere Fehlermeldungen liefern.

### P3: Persistenz, Idle und Betrieb

- Per-User-Profilauflosung, Download-Grenzen, Profil-Lifecycle und sichere Loeschaktion implementieren.
- Dienst-internes Chromium-Idle-Management bauen und Ressourcen bei Inaktivitaet messen.
- CLI-Status, Healthcheck und Logs um den optionalen Dienst erweitern.
- Managed-Statusreporting ueber den bestehenden Canvas Host Agent ergaenzen, ohne Self-Hosted davon abhaengig zu machen.

### P4: Optionales Start-on-Demand

- Nur nach gemessener Notwendigkeit bewerten.
- Managed: Allowlist-Aktion ueber den bestehenden Canvas Host Agent und die Canvas-CLI.
- Self-Hosted: optionaler lokaler Supervisor oder bewusst manuelle CLI-Verwaltung; keine versteckte Docker-API aus der Web-App.

## 9. Verifikation

- Unit- und Integrationstests fuer Ticket-Signatur, Session-/User-Bindung, Rechteverlust, Proxy-Origin, Profilisolation, Download-Grenzen und Idle-Status.
- Compose- und Healthcheck-Test mit frisch erzeugtem Test-Container; keine parallelen Test-Container.
- Vor einem Container-Build `npm run build`.
- UI-/End-to-End-Test des manuellen Desktop-Modus erst nach ausdruecklicher Nutzerfreigabe fuer Playwright oder Chrome DevTools.
- Manuelle Abnahme: Desktop ist nur nach Canvas-Login sichtbar, ein Nutzer sieht kein fremdes Profil, der VNC-Dienst ist nicht direkt von aussen erreichbar und die Sitzung laesst sich nach Idle mit demselben Profil fortsetzen.
