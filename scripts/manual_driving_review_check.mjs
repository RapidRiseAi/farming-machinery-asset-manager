// Mutation checks run only against throwaway PGlite databases. Source stays unchanged.
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./migrate_check.mjs',import.meta.url),'utf8');
const mutations=[
 ['changed retry',/if old.client_payload is distinct from payload then raise exception 'driving-request-changed' using errcode='22023'; end if;/,''],
 ['stale itinerary',/if \(p_destination is not null or p_stops is not null\) and p_plan_version is distinct from\s*\(select plan_version from public.driving_sessions where id=p_session\) then/,'if false then'],
 ['backwards reading',/if p_km<last_km then raise exception 'driving-km-backwards' using errcode='22023'; end if;/,''],
 ['coordinate entitlement',/not app.farm_plan_allows\(p_farm,'maps'\)/,'false'],
];
for(const [name,pattern,replacement] of mutations){
 const patch=`let sql=read(path.join(migrationsDir,f));if(f==='20261117110000_manual_driving_log.sql'){const changed=sql.replace(${pattern},()=>${JSON.stringify(replacement)});if(changed===sql)throw new Error('Mutation did not match');sql=changed;}await db.exec(sql);`;
 const runner=join(import.meta.dirname,`.manual-review-${process.pid}.mjs`);
 let result;
 try{writeFileSync(runner,source.replace('await db.exec(read(path.join(migrationsDir, f)));',()=>patch));result=spawnSync(process.execPath,[runner,'--suite','manual_driving.sql'],{encoding:'utf8'});}
 finally{unlinkSync(runner);}
 const output=result.stdout+result.stderr;
 assert.notEqual(result.status,0,`${name}: mutation was not caught`);
 assert.match(output,/FAIL  manual_driving.sql/,'must fail behaviour, not migration parsing');
 assert.match(output,/MANUAL:/,'must fail a test assertion');
 console.log(`CAUGHT ${name}: ${output.split('\n').find(line=>line.includes('MANUAL:'))?.trim()}`);
}
