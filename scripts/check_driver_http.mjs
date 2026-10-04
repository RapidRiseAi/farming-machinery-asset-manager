// Non-mutating smoke checks against a running build. No production credentials needed.
import assert from 'node:assert/strict';
const base=process.env.DRIVER_CHECK_URL??'http://localhost:3124';
const token='da300000-0000-4000-8000-000000000001';
const qr=await fetch(`${base}/m/${token}`,{headers:{'accept-language':'en'}});
assert.equal(qr.status,200);
const html=await qr.text();
assert.match(html,/Your vehicle, connected/);
assert.match(html,/Discover Fleetwise/);
assert.match(html,/\/login\?next=/);
assert.ok(!html.includes('qr-reading')&&!html.includes('qr-litres'),'anonymous capture form leaked');
const login=await fetch(`${base}/login?next=${encodeURIComponent(`/m/${token}`)}`);
assert.match(await login.text(),new RegExp(`name="next" value="/m/${token}"`));
for(const path of ['/driver/activity','/admin/driver-integrations']) {
 const response=await fetch(base+path,{redirect:'manual'});
 assert.equal(response.status,307);assert.match(response.headers.get('location'),/\/login/);
}
const integration=await fetch(`${base}/api/integrations/driving`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
assert.equal(integration.status,401);
const fault=new FormData();fault.set('token',token);fault.set('description','must never write');
const rejected=await fetch(`${base}/api/public/fault`,{method:'POST',headers:{origin:base},body:fault});
assert.equal(rejected.status,403);
console.log('PASS: guest QR, login return path, protected routes, unauthenticated integration and QR capture');
