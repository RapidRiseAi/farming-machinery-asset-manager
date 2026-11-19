/** Private conversations, temporary command audio and export archives never belong in a business export. */
export function businessExportFiles<T extends {bucket_id:string}>(files:T[],bucket:string):T[] {
  return files.filter(file=>file.bucket_id!=="chat-files"&&file.bucket_id!=="command-audio"&&file.bucket_id!=="farm-exports"&&file.bucket_id===bucket);
}
