import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialResolver, parseCredentialExport } from '../src/n8n/credential-export.ts';

test('credential export accepts a plain JSON array and a copied terminal prompt', () => {
  const data = [{id:'export-id',name:'Sheets',type:'googleSheetsOAuth2Api',data:{clientId:'example'}}];
  const source = JSON.stringify(data);
  for (const suffix of ['', 'root@server:/opt/n8n# ', '\r\n~ $\r\n']) {
    assert.deepEqual(parseCredentialExport(source+suffix),data);
  }
  for (const invalid of [source+'\nroot@host:~# echo private-value', 'private-value', '{}', '[null]']) {
    assert.throws(()=>parseCredentialExport(invalid),error=>error instanceof Error && !error.message.includes('private-value'));
  }
});

test('resolution prefers exported id and accepts only an unambiguous name of the same type', () => {
  const entry = {id:'export-id',name:'Sheets',type:'googleSheetsOAuth2Api',data:{clientId:'example'}};
  const node = {credentials:{googleSheetsOAuth2Api:{id:'source-id',name:'Sheets'}}};
  const resolve = credentialResolver([entry,{...entry,type:'other'}]);
  assert.deepEqual(resolve(node,entry.type),entry.data);
  const duplicate = credentialResolver([entry,{...entry,id:'another-id',data:{clientId:'another'}}]);
  assert.throws(()=>duplicate(node,entry.type),/duplicate/);
  node.credentials.googleSheetsOAuth2Api.id=entry.id;
  assert.deepEqual(duplicate(node,entry.type),entry.data);
});
