'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const dir=path.join('work','shared-publish');
fs.mkdirSync(dir,{recursive:true});
const bytes=Buffer.alloc(160000,7);
fs.writeFileSync(path.join(dir,'video.mp4'),bytes);
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({
  schemaVersion:1,status:'prepared',preparedAt:new Date().toISOString(),
  title:'Fixture video for adapter validation',sourcePage:'https://example.invalid/goushibaaz-adapter-test',
  sourceTitle:'Adapter test fixture',license:'CC0 1.0',
  licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',
  sha256,fileName:'video.mp4',caption:'Fixture caption'
},null,2)+'\n');
for(const script of ['scripts/rubika_publish_shared.cjs','scripts/telegram_publish.cjs','scripts/bale_publish.cjs']){
  const run=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,
    GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED:'false',GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED:'false'}});
  process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
  if(run.status!==0)throw new Error(script+'_failed_'+run.status);
}
for(const file of ['state/rubika-published.json','state/telegram-published.json','state/bale-published.json']){
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  const item=(state.posts||[]).find(x=>x.sourcePage==='https://example.invalid/goushibaaz-adapter-test');
  if(!item||item.status!=='dry_run_ready_no_post_sent')throw new Error(file+'_dry_run_assertion_failed');
}
console.log('SHARED_PUBLISH_ADAPTER_TEST_SUCCESS: identical artifact accepted by Rubika, Telegram and Bale; zero public posts sent.');
