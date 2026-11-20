import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const clientSource=readFileSync(new URL('../assets/site.js',import.meta.url),'utf8');
const edgeSource=readFileSync(new URL('../supabase/functions/services-intake/index.ts',import.meta.url),'utf8');
const good={
 service:'niterun-services-intake',state:'ready',
 payment_processing:false,booking_confirmation:false,marketing_enrollment:false
};

function harness(respond){
 const status={
  className:'',children:[],
  replaceChildren(){this.children=[]},
  append(value){this.children.push(value)}
 };
 const button={disabled:false};
 const listeners={};
 const form={
  dataset:{endpoint:'https://example.supabase.co/functions/v1/services-intake'},
  querySelector(selector){
   if(selector==='.form-status')return status;
   if(selector==='button[type="submit"]')return button;
   throw new Error('Unexpected selector '+selector);
  },
  addEventListener(type,cb){listeners[type]=cb},
  checkValidity(){return true}
 };
 const calls=[];
 const document={
  querySelectorAll(selector){
   if(selector==='form[data-intake-form]')return [form];
   if(selector==='.mobile-menu')return [];
   throw new Error('Unexpected document selector '+selector);
  },
  createElement(tag){return {tag,href:'',textContent:''}},
  createTextNode(text){return {textContent:text}}
 };
 runInNewContext(clientSource,{
  document,window:{location:{pathname:'/',search:''}},
  fetch:async (url,opts)=>{calls.push({url,opts});return respond(url,opts)},
  AbortController,setTimeout,clearTimeout,URLSearchParams
 },{filename:'site.js'});
 return {form,button,status,calls,listeners};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
const msg=h=>h.status.children.map(x=>x.textContent||'').join(' ');

test('healthy GET checks explicit noncommercial flags before enabling form, without POST',async()=>{
 const h=harness(async()=>({ok:true,json:async()=>good}));
 assert.equal(h.button.disabled,true,'Default must be fail closed while checking');
 await settle();
 assert.equal(h.form.dataset.intakeReady,'true');
 assert.equal(h.button.disabled,false);
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].opts.method,'GET');
 assert.equal(h.calls[0].opts.credentials,'omit');
 assert.equal(h.calls[0].opts.cache,'no-store');
 assert.match(msg(h),/not a confirmed booking/i);
});

test('unreachable backend cannot enable submit or send customer data',async()=>{
 const h=harness(async()=>{throw new Error('ENOTFOUND')});
 await settle();
 assert.equal(h.form.dataset.intakeReady,'false');
 assert.equal(h.button.disabled,true);
 assert.match(msg(h),/No request was sent/);
 assert.match(h.status.children.find(x=>x.tag==='a')?.href||'',/^mailto:/);
 h.listeners.submit({preventDefault(){}});
 await settle();
 assert.equal(h.calls.length,1,'Unverified submission must not make POST');
});

test('HTTP failure and misleading ready responses remain closed',async()=>{
 for(const respond of [
  async()=>({ok:false,status:503,json:async()=>good}),
  async()=>({ok:true,json:async()=>({...good,payment_processing:true})}),
  async()=>({ok:true,json:async()=>({...good,booking_confirmation:true})}),
  async()=>({ok:true,json:async()=>({...good,marketing_enrollment:true})}),
  async()=>({ok:true,json:async()=>({...good,state:'unavailable'})}),
  async()=>({ok:true,json:async()=>({...good,service:'other'})})
 ]){
  const h=harness(respond);
  await settle();
  assert.equal(h.form.dataset.intakeReady,'false');
  assert.equal(h.button.disabled,true);
 }
});

test('edge GET readiness requires backing table access and fails closed at 503',()=>{
 assert.match(edgeSource,/if\(req\.method==='GET'\)\{/);
 assert.match(edgeSource,/client\.from\('nr_service_requests_v1'\)/);
 assert.match(edgeSource,/\.select\('id',\{head:true\}\)\.limit\(1\)/);
 assert.match(edgeSource,/ready=!error/);
 assert.match(edgeSource,/state:ready\?'ready':'unavailable'/);
 assert.match(edgeSource,/ready\?200:503/);
 assert.match(edgeSource,/if\(url&&secret\)/);
});
