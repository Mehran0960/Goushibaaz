'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const VIDEO=path.join('work','shared-publish','video.mp4');
const MANIFEST=path.join('work','shared-publish','manifest.json');
const STATE=path.join('state','rubika-published.json');
const TOKEN=process.env.RUBIKA_BOT_TOKEN||'';
const ENABLED=/^true$/i.test(process.env.GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED||'') &&
  /^true$/i.test(process.env.GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED||'');
const API='https://botapi.rubika.ir/v3/';
const clean=v=>String(v||'').replace(/\s+/g,' ').slice(0,220);
function readState(){try{const x=JSON.parse(fs.readFileSync(STATE,'utf8'));if(Array.isArray(x.posts))return x;}catch{}return {schemaVersion:1,posts:[]};}
function saveState(s){fs.mkdirSync(path.dirname(STATE),{recursive:true});s.posts=s.posts.slice(-600);fs.writeFileSync(STATE,JSON.stringify(s,null,2)+'\n');}
async function api(method,body={}){
  const response=await fetch(API+encodeURIComponent(TOKEN)+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{throw new Error(method+'_non_json_http_'+response.status);}
  if(!response.ok||data.status!=='OK')throw new Error(method+'_http_'+response.status+'_'+clean(data.description||data.error||data.status));
  return data.data||data;
}
async function resolveChannel(){
  const result=await api('getChat',{chat_id:'@didobyn'});
  const chat=result.chat||result.channel||result;
  const id=chat.chat_id||chat.id||chat.guid;
  const username=String(chat.username||chat.user_name||'').replace(/^@/,'').toLowerCase();
  const title=String(chat.title||chat.name||'').replace(/\s/g,'');
  if(!id||(username!=='didobyn'&&title!=='دیدوبین'))throw new Error('rubika_channel_identity_check_failed');
  const expected=String(process.env.RUBIKA_CHAT_ID||'').trim();
  if(expected&&expected!==String(id))console.warn('RUBIKA_CHAT_ID_DIFFERS_FROM_VERIFIED_GETCHAT; using verified channel ID');
  return String(id);
}
async function uploadVideo(bytes){
  const request=await api('requestSendFile',{type:'Video'});
  const uploadUrl=request.upload_url||request.data?.upload_url;
  if(typeof uploadUrl!=='string'||!/^https:\/\//i.test(uploadUrl))throw new Error('requestSendFile_missing_upload_url');
  const form=new FormData();form.append('file',new Blob([bytes],{type:'video/mp4'}),'goushibaaz-short.mp4');
  const response=await fetch(uploadUrl,{method:'POST',body:form,signal:AbortSignal.timeout(180000)});
  const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data={};}
  if(!response.ok)throw new Error('rubika_file_upload_http_'+response.status);
  const fileId=data.data?.file_id||data.file_id||data.data?.file?.file_id;
  if(!fileId)throw new Error('rubika_file_upload_missing_file_id');
  return fileId;
}
async function main(){
  const manifest=(()=>{try{return JSON.parse(fs.readFileSync(MANIFEST,'utf8'));}catch{return null;}})();
  const state=readState();
  if(!manifest||manifest.schemaVersion!==1)throw new Error('shared_manifest_missing_or_invalid');
  if(manifest.status!=='prepared'){
    state.lastOutcome={status:'no_shared_candidate',checkedAt:new Date().toISOString(),manifestStatus:manifest.status};saveState(state);
    console.log('RUBIKA_SHARED_SKIP',JSON.stringify({status:manifest.status}));return;
  }
  const bytes=fs.readFileSync(VIDEO);
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  if(sha!==manifest.sha256)throw new Error('shared_video_sha256_mismatch');
  if(bytes.length<100000||bytes.length>48000000)throw new Error('shared_video_size_out_of_range');
  const previous=state.posts.find(x=>x.sourcePage===manifest.sourcePage&&['published','submitted_unconfirmed','send_started'].includes(x.status));
  if(previous){console.log('RUBIKA_SHARED_DUPLICATE_SKIP',JSON.stringify({status:previous.status}));return;}
  const entry={sourcePage:manifest.sourcePage,title:manifest.title,sha256:sha,license:manifest.license,licenseUrl:manifest.licenseUrl,status:'prepared',preparedAt:manifest.preparedAt,attemptedAt:new Date().toISOString()};
  if(!ENABLED){
    entry.status='dry_run_ready_no_post_sent';entry.checkedAt=new Date().toISOString();state.posts.push(entry);
    state.lastOutcome={status:entry.status,checkedAt:entry.checkedAt,sourcePage:entry.sourcePage,sha256:sha};saveState(state);
    console.log('RUBIKA_SHARED_DRY_RUN_READY',JSON.stringify({title:entry.title,bytes:bytes.length,sha256:sha,publicPostSent:false}));return;
  }
  if(!TOKEN)throw new Error('missing_RUBIKA_BOT_TOKEN');
  entry.status='upload_started';state.posts.push(entry);state.lastOutcome={status:'upload_started',checkedAt:entry.attemptedAt,sourcePage:entry.sourcePage};saveState(state);
  try{
    const channelId=await resolveChannel();
    const fileId=await uploadVideo(bytes);
    entry.status='submitted_unconfirmed';entry.uploadedAt=new Date().toISOString();saveState(state);
    const sent=await api('sendFile',{chat_id:channelId,file_id:fileId,text:String(manifest.caption||'').slice(0,1000)});
    const message=sent.message||sent.data?.message||sent.data||sent;
    const messageId=message.message_id||message.id;
    if(!messageId){entry.status='submitted_unconfirmed';entry.failure='accepted_without_message_id';throw new Error('rubika_sendFile_accepted_without_message_id');}
    entry.status='published';entry.messageId=String(messageId);entry.publishedAt=new Date().toISOString();
    state.lastOutcome={status:'published',checkedAt:entry.publishedAt,sourcePage:entry.sourcePage,messageId:entry.messageId,sha256:sha};
    saveState(state);console.log('RUBIKA_SHARED_PUBLISHED',JSON.stringify({messageId:entry.messageId,title:entry.title,sha256:sha}));
  }catch(error){
    if(entry.status==='upload_started')entry.status='upload_failed_retryable';
    if(entry.status==='submitted_unconfirmed')entry.failure=clean(error.message||error);
    state.lastOutcome={status:entry.status,checkedAt:new Date().toISOString(),sourcePage:entry.sourcePage,error:clean(error.message||error)};
    saveState(state);throw error;
  }
}
main().catch(e=>{console.error('RUBIKA_SHARED_PUBLISH_FAILED',clean(e.message||e));process.exitCode=1;});
