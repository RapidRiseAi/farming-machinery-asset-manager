/**
 * The "Add a document" person picker's last option: somebody who does not sign in.
 *
 * The picker opens on an empty, disabled "Choose a person", so the empty value can no
 * longer also mean "someone else", which is how a document used to be filed against
 * nobody in particular when the farmer simply had not chosen yet. This sentinel is the
 * deliberate choice, and `addDriverCredential` maps it to `user_id` null and takes the
 * typed name instead.
 *
 * A plain module, not the "use server" actions file: a server-actions module may export
 * only async functions.
 */
export const OTHER_PERSON = "someone-else";
