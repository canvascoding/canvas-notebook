# Bradley Runtime-Stabilitätsregression

Status: validiert  
Stand: 31. August 2026  
Umsetzung: BRADLEY-036

## Ziel

`Bradley` ist ausschließlich der sichtbare Name des Hauptagenten. Die technische
Identität bleibt `canvas-agent`. Diese Trennung schützt bestehende Sessions,
Automationen, API-Verträge und persistierte Agentendateien vor einer unbeabsichtigten
Umbenennung oder Datenmigration.

## Abgesicherte Invarianten

| Bereich | Stabiler Vertrag | Regressionstest |
| --- | --- | --- |
| Registry | Profilname `Bradley`, `agentId` weiterhin `canvas-agent`, Typ `main` | `bradley-runtime-stability-test.ts` |
| Interne Konstanten | Channel- und Managed-Agent-Default bleiben `canvas-agent` | `bradley-runtime-stability-test.ts` |
| Speicherpfade | Nutzerdateien liegen unter `users/<userId>/agents/canvas-agent/`; es entsteht kein Pfad `Bradley/` | `bradley-runtime-stability-test.ts` |
| Sessions | Der Datenbank-Default für `pi_sessions.agent_id` bleibt `canvas-agent` | `bradley-runtime-stability-test.ts` |
| Automationen | Der Datenbank-Default für `automation_jobs.agent_id` bleibt `canvas-agent` | `bradley-runtime-stability-test.ts` |
| Agenten-API | GET und PATCH verwenden weiterhin `agentId=canvas-agent`; `Bradley` wird nicht als technische ID eingeführt | `agent-tools-route-test.ts` |
| Bestandsmigration | Nur der sichtbare Standardname wird migriert; ID und bewusste eigene Namen bleiben erhalten | `agent-display-name-migration-test.ts` |

## Ausführung

```bash
npm run test:agent:bradley-stability
```

Der gebündelte Befehl führt den neuen Persistenztest sowie die bestehenden API- und
Display-Name-Migrationstests aus. Alle Tests verwenden isolierte temporäre Daten oder
Mocks und verändern keine produktiven Nutzerdateien.

## Nicht Bestandteil der Namensmigration

Die folgenden Werte werden nicht in `Bradley` umbenannt:

- Agenten-ID `canvas-agent`
- Session- und Automation-Zuordnung `agent_id`
- API-Parameter `agentId`
- Verzeichnisname `canvas-agent`
- bestehende Session-, Automation- oder Workspace-IDs

Eine spätere Änderung dieser technischen Werte wäre eine eigenständige,
rückwärtskompatibel zu planende Datenmigration und ist ausdrücklich nicht Teil der
Bradley-Einführung.
