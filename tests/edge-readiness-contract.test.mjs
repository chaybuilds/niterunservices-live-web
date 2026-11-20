import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const edge = readFileSync(new URL('../supabase/functions/services-intake/index.ts', import.meta.url), 'utf8');
const begin = edge.indexOf("if(req.method==='GET'){");
const end = edge.indexOf("if(req.method!=='POST')", begin);
assert.ok(begin >= 0 && end > begin, 'expected exact GET readiness branch');
// Exercise the actual JavaScript GET branch in a read-only VM with a mocked DB.
const branch = edge.slice(begin, end);
const handle = runInNewContext('(async (req, origin, response, Deno, createClient) => { ' +
  branch + " throw Error('readiness_failed_to_return'); })", {}, {timeout: 1000});

async function probe({url='https://db.invalid', secret='scoped-private-test-key', db='ok'} = {}) {
  const calls=[];
  const Deno={env:{get(name){calls.push('env:'+name);return name==='SUPABASE_URL'?url:secret;}}};
  const createClient=()=>{
    calls.push('createClient');
    if(db==='throws')throw Error('connection_failed');
    return {from(table){calls.push('from:'+table);return {
      select(column,opts){calls.push('select:'+column+':'+opts?.head);return {
        async limit(n){calls.push('limit:'+n);return {error:db==='error'?{code:'database_unavailable'}:null};}
      };}
    };}};
  };
  const response=(body,status,origin)=>({body,status,origin});
  const result=await handle({method:'GET'},'https://niterunservices.com',response,Deno,createClient);
  return {calls,...result};
}

test('missing service-role credential refuses readiness without querying',async()=>{
  const r=await probe({secret:''});
  assert.equal(r.status,503);
  assert.equal(r.body.state,'unavailable');
  assert.ok(!r.calls.includes('createClient'));
});
test('database permission or table errors refuse readiness',async()=>{
  const r=await probe({db:'error'});
  assert.equal(r.status,503);
  assert.equal(r.body.state,'unavailable');
  assert.ok(r.calls.includes('from:nr_service_requests_v1'));
  assert.ok(r.calls.includes('select:id:true'));
});
test('database transport failures refuse readiness',async()=>{
  const r=await probe({db:'throws'});
  assert.equal(r.status,503);
  assert.equal(r.body.state,'unavailable');
});
test('readable backing table yields read-only, noncommercial readiness only',async()=>{
  const r=await probe();
  assert.equal(r.status,200);
  assert.equal(r.body.state,'ready');
  assert.equal(r.body.payment_processing,false);
  assert.equal(r.body.booking_confirmation,false);
  assert.equal(r.body.marketing_enrollment,false);
  assert.ok(r.calls.includes('limit:1'));
  assert.ok(r.calls.every(x=>!/(insert|update|delete|charge|send)/i.test(x)));
});
