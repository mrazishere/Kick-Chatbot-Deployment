/**
 * Bots that show up in Kick chat with badges but are not people: Kick's own and
 * the third-party bots channels commonly add. Kept out of the moderator cache,
 * and they can never earn or hold loyalty points. Lowercase usernames.
 */
export const SYSTEM_BOTS: ReadonlySet<string> = new Set(['kickbot', 'kickcx', 'botrix', 'streamelements', 'nightbot', 'moobot']);
