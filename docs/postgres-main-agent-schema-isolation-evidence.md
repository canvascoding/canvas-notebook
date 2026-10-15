# Main-Agent-Migration: Schema-Bindung

Stand: 15. Oktober 2026. Beim vollständigen PostgreSQL-Starttest für native Dateioperationsbelege wurde ein bestehender Fehler der [Main-Agent-Migration](../app/lib/db/main-agent-id-migration.ts) sichtbar. Derselbe unveränderte Test scheitert auf Root und dem ursprünglichen QA-Stand an SQLSTATE `42P01` für `collaboration_excalidraw_creates`. Eine passive Fehlerdiagnose protokolliert nur Relationsnamen und Queryhash, keine Parameter, und bestätigt den verursachenden ursprünglichen DO-Block.

Die Migration inventarisierte Textspalten und Defaults fest in `public`, verwendete für UPDATE und ALTER aber unqualifizierte Tabellennamen. Bei `search_path=own,pg_catalog` fehlte eine nur in `public` vorhandene Relation im tatsächlichen Ziel. Bei vorhandenem Public-Fallback konnten stattdessen öffentliche Referenzen und Defaults verändert werden.

Die Korrektur begrenzt beide Inventare auf `current_schema()` und qualifiziert beide dynamischen Statements mit den tatsächlich inventarisierten Schema-/Tabellennamen über `%I.%I`. Agentprofilkopie, Konfliktprüfung und Migrationsmarker bleiben im bisherigen atomaren DO-Block. Zielvertrag ist der tatsächliche Startlauf mit dort angelegten `agents` und `canvas_data_migrations`; eine beliebige Mischung mit diesen Tabellen ausschließlich in späteren Suchpfadschemas wird damit nicht als unterstützt ausgewiesen.

Die neue [SQL-Gegenprobe](../scripts/main-agent-id-schema-isolation-test.mts) verwendet echte PGlite-Queries und die tatsächlichen Produktions-DDL der beiden Tabellen:

- Isoliertes eigenes Schema mit Quotezeichen, ohne Public-Fallback; fremde öffentliche Referenzen bleiben außerhalb der Migration.
- Eigenes Schema mit Public-Fallback, gleichnamigen sowie ausschließlich lokalen/öffentlichen Referenzen und einem dritten Schema: ausschließlich lokale Referenzen und Defaults ändern sich. Profilwerte und numerische Felder bleiben exakt; neue INSERTs verwenden die geänderten Defaults; Wiederholung erhält Daten und Marker.
- Ein bereits vorhandener Nicht-Main-Agent unter der kanonischen ID führt zur atomaren Ablehnung ohne Änderungen an einem der Schemas.

Identische Testbytes, SHA-256 `022744f02f17bd5d4256a046092ce30f8bc019e76d84aeebff821a11a67307e1`: vor der Korrektur tatsächlich Exit 1, zwei Fehler und eine bestandene Kontrolle; danach Exit 0, drei von drei bestanden. Der erste Fehler ist echte fehlende Relation, der zweite eine tatsächliche Änderung fremder Daten/Defaults. Produktdatei vorher `ba078dd524827db81d7d6342607c4f2c8cd3835066b922224706ba50aa6c35d8`, danach `19509163360a70e5051fc2e56dd09ca35e4ed3401bce710f29eff85d9f94a953`.

Der unveränderte [vollständige PG18-Starttest](../scripts/native-file-operation-storage-migration-postgres-test.ts) besteht anschließend mit tatsächlichem Exit 0: drei Startdurchläufe auf derselben eigenen Schema-/Backendbindung, erhaltene Metadaten und private Intents, lokale FKs/Trigger, Immutability und echte Deferred-COMMIT-Ablehnung; eigenes Schema entfernt. Der vollständige PGlite-Starttest und die bestehende [Standard-Agentenmigration](../scripts/bradley-agent-id-postgres-migration-test.ts) bestehen ebenfalls nach der Korrektur. Das sind lokale SQL-/Startnachweise; es wurde kein produktiver Datenbestand migriert.

Reproduzierbare Gegenprobe:

```sh
NODE_ENV=test CANVAS_MCP_DIRECT_ENABLED=false BETTER_AUTH_BASE_URL=https://canvas.test \
  node --conditions=react-server --import tsx --test scripts/main-agent-id-schema-isolation-test.mts
```

GitNexus meldet für den globalen Startanschluss CRITICAL: ein direkter Aufrufer, 258 erfasste Abhängigkeiten, keine im Index zugeordneten Prozesse. Die Warnung erfolgte vor der Änderung. Der unabhängige Quellenreview bestätigt den engen Schema-Schnitt; die allgemeinen Dateiaktionsgates werden hierdurch nicht aktiviert.

Auf dem kombinierten finalen Quellenstand dieser Korrektur und der [Receiptversionsprüfung](./yjs-native-file-operation-version-evidence.md) bestehen vollständiges TypeScript ohne inkrementellen Cache mit 8 GiB sowie fokussiertes ESLint, jeweils mit tatsächlichem Exit 0.
