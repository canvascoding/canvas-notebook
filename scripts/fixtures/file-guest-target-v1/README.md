# Frozen Guest target V1 sideeffects fixture

These two immutable source snapshots come from Notebook commit `6cac42e1873d873f1ef311cd7f362a02e51b0c56`, before invitation lifecycle/lineage binding columns were added. `provenance.json` records each original and fixture SHA-256. The only changes are quoted relative import paths: production dependencies resolve under `../../../app/lib`, and the runtime imports its colocated frozen row specification. There are no SQL, function-body, result or receipt adjustments.

The isolated PostgreSQL test runs this original migration and runtime against the actual old Guest table shape to commit an original V1 archive stage and receipt. It then applies the real additive target migration and current sideeffect SQL, keeps all historical stored bytes and digests unchanged, and exercises the current reader and native Restore. This is a migration regression fixture, not a production implementation or an alternate dispatcher.

Do not regenerate this snapshot from current source. Future changes require separate fixtures; this historical contract stays frozen.
