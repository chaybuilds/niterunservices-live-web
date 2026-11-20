import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Execute the actual post-validation Supabase response path; no live DB or PII.
const source=readFileSync(new URL('../supabase/functions/services-intake/index.ts',import.meta.url),'utf8');
const begin=source.indexOf('const {count:recentCount,error:rateError}');
const final='return response({accepted:true,duplicate:false,booking_confirmed:false},201,origin);';
const end=source.indexOf(final,begin);
assert.ok(begin>=0 && end>begin,'expected actual intake write path');
const snippet=source.slice(begin,end+final.length);
const args=['client','response','origin','ip_hash','submission_hash','since','now',
 'full_name','email','phone','postal_code','service','city','timing','details',
 'source','campaign','landing_path'];
const handle=runInNewContext('(async ('+args.join(',')+') => { '+snippet+' })',{}, {timeout:1000});

async function probe({rate={count:0,error:null},duplicate={data:null,error:null},
 insert={data:{id:'e680ab88-33df-4024-ad62-37b81c06746c'},error:null}}={}){
 const calls=[];
 const client={from(table){
  assert.equal(table,'nr_service_requests_v1');
  return {
   select(field,opts){
    assert.equal(field,'id');
    return {eq(key){
     return {
      gte(){calls.push('rate');return rate;},
      maybeSingle(){calls.push('duplicate');return duplicate;}
     };
    }};
   },
   insert(record){calls.push('insert');assert.equal(record.verified_payment_cents,0);
    assert.equal(record.provider_verified,false);
    return {select(field){assert.equal(field,'id');return {
     single(){return insert;}
    };}};}
  };
 }};
 const response=(body,status)=>({status,body});
 const values=[client,response,'https://niterunservices.com','fake-ip-hash',
  'fake-submission-hash','2026-11-20T18:30:00Z',
  new Date('2026-11-20T18:53:00Z'),'Synthetic Test Person','fake@example.invalid',
  '', '28401','cleaning','wilmington','week','Synthetic intake test only',
  'direct','','/services/cleaning/'];
 const result=await handle(...values);
 return {result,calls};
}

test('explicit database success produces an unconfirmed intake receipt',async()=>{
 const {result,calls}=await probe();
 assert.equal(result.status,201);
 assert.deepEqual(JSON.parse(JSON.stringify(result.body)),{accepted:true,duplicate:false,booking_confirmed:false});
 assert.deepEqual(calls,['rate','duplicate','insert']);
});
test('null error without a returned persisted row is not an accepted inquiry',async()=>{
 for(const insert of [{error:null,data:null},{error:null},
  {error:null,data:{}},{error:null,data:{id:'not-a-uuid'}},
  {error:null,data:{id:123}}]){
  const {result,calls}=await probe({insert});
  assert.equal(result.status,503,'explicit persisted row identity required');
  assert.equal(result.body.accepted,undefined);
  assert.deepEqual(calls,['rate','duplicate','insert']);
 }
});

test('ambiguous write result cannot claim receipt acceptance',async()=>{
 for(const insert of [{},{error:undefined},{error:false}]){
  const {result,calls}=await probe({insert});
  assert.equal(result.status,503,'no explicit null error must HOLD intake');
  assert.equal(result.body.accepted,undefined);
  assert.deepEqual(calls,['rate','duplicate','insert']);
 }
});
test('database uniqueness race is an unconfirmed duplicate, not a new booking',async()=>{
 const {result}=await probe({insert:{error:{code:'23505'}}});
 assert.equal(result.status,200);
 assert.deepEqual(JSON.parse(JSON.stringify(result.body)),{accepted:true,duplicate:true,booking_confirmed:false});
});
test('unproven rate-limit count cannot allow new customer writes',async()=>{
 for(const rate of [{count:null,error:null},{error:null},{count:0,error:false}]){
  const {result,calls}=await probe({rate});
  assert.equal(result.status,503);
  assert.deepEqual(calls,['rate']);
 }
});
test('ambiguous prior-duplicate lookup cannot allow new customer writes',async()=>{
 for(const duplicate of [{error:null},{data:null},{data:null,error:false}]){
  const {result,calls}=await probe({duplicate});
  assert.equal(result.status,503);
  assert.deepEqual(calls,['rate','duplicate']);
 }
});
test('existing duplicate, rate limit and actual database errors retain their holds',async()=>{
 const dup=await probe({duplicate:{data:{id:'synthetic'},error:null}});
 assert.equal(dup.result.status,200);assert.deepEqual(dup.calls,['rate','duplicate']);
 const limited=await probe({rate:{count:5,error:null}});
 assert.equal(limited.result.status,429);assert.deepEqual(limited.calls,['rate']);
 const dbErr=await probe({insert:{error:{code:'DB_DOWN'}}});
 assert.equal(dbErr.result.status,503);
});
