/** Business-wide exports use a service client; private conversations require membership. */
export function businessExportFiles<T extends {bucket_id:string}>(files:T[],bucket:string):T[] {
  return files.filter(file=>file.bucket_id!=="chat-files"&&file.bucket_id===bucket);
}
