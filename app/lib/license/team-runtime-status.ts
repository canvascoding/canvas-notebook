export type TeamRuntimeLicenseStatus = {
  licensed?: boolean;
  databaseProvider?: string | null;
  runtimeDatabaseProvider?: string | null;
  capabilities?: Record<string, boolean>;
  features?: Record<string, boolean>;
};

export function includesTeamRuntimeLicense(status: TeamRuntimeLicenseStatus): boolean {
  const multiUser = status.capabilities?.multiUser ?? status.features?.multiUser;
  const teamWorkspace = status.capabilities?.teamWorkspace ?? status.features?.teamWorkspace;
  const runtimeDatabaseProvider = status.runtimeDatabaseProvider ?? status.databaseProvider;
  return status.licensed === true
    && multiUser === true
    && teamWorkspace === true
    && runtimeDatabaseProvider === 'postgres';
}
