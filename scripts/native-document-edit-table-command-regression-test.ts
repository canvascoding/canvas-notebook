import assert from 'node:assert/strict';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { prepareAgentBlockEdit, previewAgentBlockEdit, applyAgentBlockEdit } from '../app/lib/collaboration/agent-block-edits';
import { prepareNativeDocumentEditInDocument } from '../app/lib/collaboration/native-document-edit-preparation';
import { validateNativeDocumentEditCandidate } from '../app/lib/collaboration/native-document-edit-validation';
import { documentVersionV1 } from '../app/lib/documents/read-version';

/** Actual isolated Yjs/preparation regression, no principal or persistence claim. */
export function nativeDocumentEditTableCommandRegressionTest(): void {
  const doc=nativeTableWidthFixture('tiptap_blocks','Edited Blocks');
  let failures=0;
  const check=(stage:string,action:()=>void)=>{
    try{action();console.log(JSON.stringify({stage,passed:true}));}
    catch(error){failures++;const code=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;
      console.log(JSON.stringify({stage,passed:false,name:error instanceof Error?error.name:'unknown',code:typeof code==='string'?code:null}));}
  };
  try{
    const tableCell=readAgentBlockStructure(doc).find(block=>block.type==='tableCell');assert(tableCell?.tableOperationTarget);
    const operation={kind:'table_operation' as const,...tableCell.tableOperationTarget,action:'addRowAfter' as const};
    const identity={workspaceId:'table-test-workspace',organizationId:null,documentId:'table-test-document',lineageId:'table-test-lineage',
      lifecycleGeneration:1,representation:'tiptap_blocks' as const,schemaVersion:COLLABORATION_SCHEMA_VERSION};
    const proof=collaborationStateProof(doc,Y);assert(proof);const before=Y.encodeStateAsUpdate(doc);
    check('complete native preparation on native-only table',()=>{
      const prepared=prepareNativeDocumentEditInDocument({doc,identity,expectedVersion:documentVersionV1(identity,proof),
        patch:{kind:'native_blocks',operations:[operation]},groupId:'table-regression'});
      assert.equal(prepared.noChange,false);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
    });
    check('existing block preparation/preview/apply on native-only table',()=>{
      const existing=readAgentBlockStructure(doc);
      const oldCells=existing.filter(block=>block.type==='tableHeader'||block.type==='tableCell');
      assert.equal(oldCells.length,2);
      const originalCells=new Map(oldCells.map(block=>[block.id,block]));
      const prepared=prepareAgentBlockEdit(doc,[operation]);previewAgentBlockEdit(doc,prepared);
      assert.deepEqual(Y.encodeStateAsUpdate(doc),before,'Preparation and preview must leave the source untouched.');
      applyAgentBlockEdit(doc,prepared,'agent');assert.equal(validateNativeDocumentEditCandidate(doc,'tiptap_blocks'),null);
      const after=readAgentBlockStructure(doc);
      assert.equal(after.filter(block=>block.type==='tableRow').length,3);
      const cells=after.filter(block=>block.type==='tableHeader'||block.type==='tableCell');
      assert.equal(cells.length,3);
      for(const cell of cells)assert.deepEqual(cell.attrs.colwidth,[120],'Every original and added cell retains the column width.');
      for(const [id,original] of originalCells){
        const cell=cells.find(cell=>cell.id===id);assert(cell);
        assert.deepEqual(cell.attrs,original.attrs);assert.equal(cell.subtreeHash,original.subtreeHash);
      }
    });
  }finally{doc.destroy();}
  assert.equal(failures,0,'Native-only table command preparation must succeed.');
}
nativeDocumentEditTableCommandRegressionTest();
