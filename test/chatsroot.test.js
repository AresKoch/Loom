const test=require('node:test'),assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {create}=require('../backend.js');
test('chats follow root up and down but not sideways',async()=>{
  const t=fs.mkdtempSync(path.join(os.tmpdir(),'ad-')),deep=path.join(t,'a','b'),other=path.join(os.tmpdir(),'other-'+Date.now());
  fs.mkdirSync(path.join(deep,'.folder-map','chats'),{recursive:true});fs.mkdirSync(path.join(other,'.folder-map','chats'),{recursive:true});
  fs.writeFileSync(path.join(deep,'.folder-map','chats','abc123.json'),JSON.stringify({title:'x',session:'s1',msgs:[]}));
  fs.writeFileSync(path.join(other,'.folder-map','chats','zzz999.json'),JSON.stringify({title:'o',msgs:[]}));
  const b=create({workspace:deep});
  const r=await b.adoptChats({into:t,from:[deep,other]});
  assert.equal(r.moved,1);
  const j=JSON.parse(fs.readFileSync(path.join(t,'.folder-map','chats','abc123.json')));
  assert.equal(j.sessionRoot,deep);
  assert.ok(!fs.existsSync(path.join(deep,'.folder-map','chats','abc123.json')));
  assert.ok(fs.existsSync(path.join(other,'.folder-map','chats','zzz999.json')));
});
