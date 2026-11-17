// Local PGlite evidence only. No environment credentials, network or checkout edits.
// node scripts/chat_review_check.mjs [mutations|storage|baseline]
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const mode=process.argv[2]??'mutations';
const source=readFileSync(new URL('./migrate_check.mjs',import.meta.url),'utf8');
const mutations=[
  ['membership',/create or replace function app\.chat_can_read\(p_conversation uuid\)[\s\S]*?\$\$;/,
    "create or replace function app.chat_can_read(p_conversation uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select true; $$;"],
  ['join history',/ and x.sequence > m.visible_after/,''],
  ['group admin',/if c.kind <> 'group' or not exists\(select 1 from public.chat_members m[\s\S]*?then/,'if false then'],
  ['changed retry',/if msg.body is distinct from btrim\(coalesce\(p_body,''\)\) or msg.deleted_at is not null then raise exception 'chat-request-changed'; end if;/,''],
  ['inactive membership',/and m.active and m.deleted_at is null and m.role/,'and m.deleted_at is null and m.role'],
];
const storage=`
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  insert into storage.buckets(id,name,public) values('chat-files','chat-files',true);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated;
  grant select,insert,update,delete on storage.objects to authenticated;
  -- Deliberately broad legacy policy: B2's restrictive policy must still protect chat.
  create policy legacy_open on storage.objects for all to authenticated using(true) with check(true);
`;
function run(name,script,suite,expectedFailure){
  // The generated runner remains alongside the original so its relative paths are unchanged.
  const path=join(import.meta.dirname,`.chat-review-${process.pid}.mjs`);
  let result;
  try {writeFileSync(path,script);result=spawnSync(process.execPath,[path,'--suite',suite],{encoding:'utf8'});}
  finally {unlinkSync(path);}
  const output=result.stdout+result.stderr;
  if(expectedFailure){
    assert.notEqual(result.status,0,`${name}: mutation was not caught`);
    assert.match(output,/FAIL  staff_chat.sql/,'mutation must fail the behavioural suite, not migration parsing');
    console.log(`CAUGHT ${name}: ${output.split('\n').find(line=>line.includes('CHAT:'))?.trim()}`);
  }else{
    console.log(output);if(result.status!==0)process.exitCode=1;
  }
}
if(mode==='mutations')for(const [name,pattern,replacement] of mutations){
  const patch=`let sql=read(path.join(migrationsDir,f)); if(f==='20261117090000_staff_chat.sql'){const changed=sql.replace(${pattern},()=>${JSON.stringify(replacement)});if(changed===sql)throw new Error('mutation did not match');sql=changed;}await db.exec(sql);`;
  run(name,source.replace('await db.exec(read(path.join(migrationsDir, f)));',()=>patch),'staff_chat.sql',true);
}else if(mode==='storage'){
  const patch=`if(f==='20261117090100_chat_uploads.sql')await db.exec(${JSON.stringify(storage)});await db.exec(read(path.join(migrationsDir, f)));`;
  run(mode,source.replace('await db.exec(read(path.join(migrationsDir, f)));',()=>patch),'staff_chat.sql',false);
}else if(mode==='baseline'){
  run(mode,source.replace('.filter((f) => f.endsWith(".sql")).sort()', '.filter((f) => f.endsWith(".sql") && !f.startsWith("20261117")).sort()'),'billing_review_5.sql',false);
}else throw new Error('Unknown check');
