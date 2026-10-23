# Native-Mobile-Adapter für begrenztes Peer-Busy

Stand: 14. Oktober 2026. **Eigener Mobile-Sourceabschluss; Geräteabnahme offen.**

Der isolierte manuelle Git-Worktree `/Users/frankalexanderweber/.codex/worktrees/native-mobile-admission-busy/canvas-notebook-mobile` enthält Commit `acfa5061956824775e1dd2444a6828e0d164e468` auf Basis `3ba1eb92dee91c198265403d09395bd1e3a8fff8`. Die App hat ihn nicht als verwalteten Worktree registriert; das primäre Mobile-Checkout bleibt sauber auf seiner Basis. Es gab keinen Push, nativen Build oder Deployment.

## Verhalten

Der Adapter pausiert bei genau dem bestätigten nativen Peer-Busycode. Er erhält dieselbe Y.Doc-Instanz, Drafts, Löschungen, Undo, Rechte und Quarantäne. Eine noch unbestätigte kalte Sitzung wird dadurch nicht editierbar. Ausstehende Tickets und Checkpoints werden verworfen; verspätete Antworten sowie bereits geplante Provider-Reconnects dürfen die Pause nicht umgehen. Unbekannte Fehler und späterer Rechteentzug bleiben Ablehnungen.

Die unabhängige Prüfung fand zwei Fehler im Zusammenspiel mit einer pausierten Migration: Busy konnte ignoriert und ein späterer Authentisierungsfehler verdeckt werden. Die Korrekturen sind mit erhaltenen roten und grünen Gegenfällen belegt. Der bestehende native Bridge-/Screen-/API-Vertrag und die Buildzähler bleiben unverändert. Die portable Core-Ausgabe entspricht dem geprüften Notebook-Protokollstand `2315c1c674ec2662bb906dabdd365dd89f987f89`.

## Tatsächliche Prüfungen

Root hat die Zustandssuite und die Laufzeitprüfung des generierten Editor-HTML mit dem tatsächlich installierten Provider selbst erfolgreich ausgeführt. Die Autorenprüfung umfasst außerdem echte Roundtrips durch den Mobile-Nachrichtenparser. Das ist Source-/generierte-HTML-Laufzeitevidenz, keine physische WebView-/Geräteabnahme.

Der finale vollständige `npm run verify` endet mit Exit `1` bei Expo Doctor: 19 von 20 Prüfungen bestehen; 13 Patchversionen entsprechen nicht dessen Empfehlungen. Die betroffenen installierten Versionen und Lockfileeinträge sind mit dem primären Checkout und der unveränderten Basis abgeglichen. Es wurden weder Abhängigkeiten installiert noch Empfehlungen oder Ausschlussregeln verändert. Die vorherigen Prüfungen einschließlich TypeScript, Lint und Laufzeitsuiten bestehen. Wegen der unterbrochenen `&&`-Kette wurden die nachfolgenden Prüfungen separat ausgeführt: `audit:production` und der tatsächliche Android-/iOS-/Web-Export bestehen jeweils mit Exit `0`.

Root hat die 13 geänderten Quelldateien und drei generierten HTML-Artefakte gegen den eingefrorenen Stand sowie zwölf vollständige geschützte Dateien gegen die Basis geprüft. Die tatsächlichen Prüfprozesse sind geschlossen. Das vollständige Verify bleibt als fehlgeschlagen ausgewiesen.

## Private Belege

| Beleg | SHA-256 |
| --- | --- |
| Autorenmanifest | `d358c4eb16dc14613adc001e800d733119ffcba2b16043d903b3f7497da9d400` |
| Unabhängiger Rootbeleg | `cdcd9a8f78a25aade1549298fc300c8df5777d392104dc74b89d5aef34b9f2fe` |

- `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-mobile-native-admission-95i134jy/completion-manifest.json`
- `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-mobile-admission-root-3oqk4euv/root-evidence.json`

Der separate [kompilierte Server-Protokollnachweis](./yjs-native-compiled-protocol-evidence.md) besteht ebenfalls. Eine Mobile-Geräteabnahme oder die gemeinsame Notebook-Browserabnahme folgt daraus nicht.
