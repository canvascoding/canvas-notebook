import { workspaceOperationUnexportableNativePathPublicPostgresTest } from './workspace-operation-unexportable-native-path-public-postgres-test';

try { await workspaceOperationUnexportableNativePathPublicPostgresTest(); } catch { process.exitCode = 1; }
