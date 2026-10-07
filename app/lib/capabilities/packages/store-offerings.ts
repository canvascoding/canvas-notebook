/** Bounded discovery always includes the explicitly selectable latest release and its digest. */
export function projectCapabilityPackageStoreVersions(versions: Readonly<Record<string, { version: string; checksum: string }>>,
  latestVersion: string): Array<{ version: string; checksum: string }> {
  const latest = versions[latestVersion], selected = latest ? [latest] : [];
  for (const version of Object.values(versions)) {
    if (selected.length >= 100) break;
    if (version.version !== latest?.version) selected.push(version);
  }
  return selected.map(version => ({ version: version.version, checksum: version.checksum.replace(/^sha256:/iu, '').toLowerCase() }));
}
