import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../assets/site.js',import.meta.url),'utf8');

async function simulateHealth(response){
 const calls=[];
 const status={className:'',content:[],replaceChildren(){this.content=[]},append(value){this.content.push(value)}};
 const button={type:'button',disabled:true};
 const form={dataset:{endpoint:'https://example.invalid/functions/v1/services-intake'},onSubmit:null,
  querySelector(selector){return selector==='[data-intake-submit]'?button:selector==='.form-status'?status:null},
  addEventListener(type,cb){if(type==='submit')this.onSubmit=cb}};
 const doc={querySelectorAll(selector){return selector==='form[data-intake-form]'?[form]:[]},
  createElement(){return {textContent:'',href:'',append(){}}},
  createTextNode(text){return {textContent:text}}};
 const ctx={document:doc,window:{location:{pathname:'/services/cleaning/'}},
  AbortController,URLSearchParams,setTimeout,clearTimeout,
  fetch:async(url,options)=>{calls.push({url,method:options.method});return response()}};
 runInNewContext(source,ctx,{timeout:1000});
 await new Promise(resolve=>setTimeout(resolve,0));
 return {form,button,status,calls};
}

test('failed readiness request leaves intake disabled and never posts contact data',async()=>{
 const r=await simulateHealth(()=>{throw Error('offline')});
 assert.equal(r.form.dataset.intakeReady,'false');
 assert.equal(r.button.disabled,true);
 assert.equal(r.button.type,'button');
 r.form.onSubmit({preventDefault(){}});
 assert.deepEqual(r.calls.map(x=>x.method),['GET']);
 assert.match(r.status.content[0].textContent,/not currently verified as available/);
});

test('unverified, restricted, or missing readiness flags fail closed',async()=>{
 const candidates=[{state:'ready'},
  {state:'ready',payment_processing:true,booking_confirmation:false,marketing_enrollment:false},
  {state:'ready',payment_processing:false,booking_confirmation:false,marketing_enrollment:true},
  {state:'offline',payment_processing:false,booking_confirmation:false,marketing_enrollment:false}];
 for(const body of candidates){
  const r=await simulateHealth(()=>({ok:true,json:async()=>body}));
  assert.equal(r.form.dataset.intakeReady,'false');
  assert.equal(r.button.disabled,true);
  assert.deepEqual(r.calls.map(x=>x.method),['GET']);
 }
});

test('complete affirmative read-only readiness alone unlocks form, without posting',async()=>{
 const body={state:'ready',payment_processing:false,booking_confirmation:false,marketing_enrollment:false};
 const r=await simulateHealth(()=>({ok:true,json:async()=>body}));
 assert.equal(r.form.dataset.intakeReady,'true');
 assert.equal(r.button.disabled,false);
 assert.equal(r.button.type,'submit');
 assert.deepEqual(r.calls.map(x=>x.method),['GET']);
});
