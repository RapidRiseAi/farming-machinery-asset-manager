import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { businessExportFiles } from "./privacy";
test("service-backed business export cannot turn ownership into private chat access",()=>{
  const files=[{bucket_id:"chat-files",name:"same-farm/private.jpg"},{bucket_id:"machine-photos",name:"same-farm/public-to-business.jpg"}];
  assert.deepEqual(businessExportFiles(files,"chat-files"),[]);
  assert.deepEqual(businessExportFiles(files,"machine-photos"),[files[1]]);
  assert.deepEqual(businessExportFiles(files,"unknown"),[]);
  const route=readFileSync(new URL("../../app/api/farm/export/files/route.ts",import.meta.url),"utf8");
  assert.match(route,/const files = businessExportFiles\(/,"the service download must use the private-chat exclusion");
});
