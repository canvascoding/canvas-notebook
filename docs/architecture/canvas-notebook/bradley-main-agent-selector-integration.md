# Bradley im Hauptagent-Selector und Chat-Header

Status: implementiert und validiert  
Stand: 31. August 2026  
Umsetzung: BRADLEY-040

## Ergebnis

Der Hauptagent mit der internen ID `canvas-agent` erscheint im Home-Selector,
im Chat-Selector und im Chat-Header immer mit dem vollständigen Namen
`Bradley`. Das gilt auch dann, wenn ein historischer Hauptagent-Datensatz noch
einen anderen Profilnamen enthält. Die Datenbank bleibt dabei unverändert; die
Festlegung ist eine reine UI-Identitätsregel.

Spezialagenten werden nicht normalisiert. Ihr konfigurierter vollständiger Name
und ihr eigenes `iconId` werden unverändert an den gemeinsamen Selector und den
Chat-Header weitergegeben.

## Umsetzung

| Baustein | Verantwortung |
| --- | --- |
| `getAgentProfileDisplayName()` | bindet ausschließlich `canvas-agent` an Bradley und erhält Profilnamen anderer Agenten |
| `CanvasAgentChat` | normalisiert aktiven Headernamen und die sichtbare Agentenliste |
| `PromptHero` | normalisiert Hauptagentenname im Home-Selector |
| `ChatAgentSelector` | bleibt generisch und rendert weiterhin übergebene Namen und Icons |

Die gemeinsame Selector-Komponente wurde bewusst nicht auf Bradley
spezialisiert. Dadurch kann sie für Hauptagent und Spezialagenten dieselbe
Interaktion anbieten, ohne deren Identitäten zu vermischen.

## Regressionstest

```bash
npm run test:agent:bradley-selector
```

Der Test belegt:

- alte oder individuelle Profilnamen des Hauptagenten werden sichtbar Bradley;
- Spezialagenten behalten ihren vollständigen Profilnamen;
- ein namenloser Spezialagent erhält weiterhin den neutralen ID-Fallback;
- Home und Chat wenden dieselbe sichtbare Identitätsregel an;
- der generische Selector rendert weiterhin die agentenspezifischen Icons.

Die visuelle Prüfung in Desktop-, Mobile-, Light- und Dark-Varianten bleibt
BRADLEY-044 vorbehalten und wird erst nach ausdrücklicher Browserfreigabe
durchgeführt.
