import { workspaceMixedHtmlPublicCoreV5Test } from './workspace-mixed-html-public-core-v5-test';
import { workspaceNativeLinkMutationsV4Test } from './workspace-native-link-mutations-v4-test';
import { workspacePathHtmlNoImportPreparationTest } from './workspace-path-html-no-import-preparation-test';
import { workspaceOperationOriginalMoveHtmlPreparationTest } from './workspace-operation-original-move-html-preparation-test';
import { workspaceOperationOriginalMoveHtmlSourcesTest } from './workspace-operation-original-move-html-sources-test';
import { workspacePathHtmlWebPreviewTest } from './workspace-path-html-web-preview-test';
import { mcpServerWorkspaceHtmlPathContractTest } from './mcp-server-workspace-html-path-contract-test';
import { workspaceOperationOriginalMovePristineSourcesTest } from './workspace-operation-original-move-pristine-sources-test';

workspaceNativeLinkMutationsV4Test();
workspaceMixedHtmlPublicCoreV5Test();
workspacePathHtmlNoImportPreparationTest();
workspaceOperationOriginalMoveHtmlPreparationTest();
workspaceOperationOriginalMoveHtmlSourcesTest();
workspaceOperationOriginalMovePristineSourcesTest();
workspacePathHtmlWebPreviewTest();
await mcpServerWorkspaceHtmlPathContractTest();
