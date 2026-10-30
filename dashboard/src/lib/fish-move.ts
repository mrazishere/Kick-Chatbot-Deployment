/** A fishing-page move, its words joined by spaces, can be as long as a Kick chat message, so the
 * page can name as many fish as chat can. The bot checks the same limit. */
export const MOVE_MAX_CHARS = 500;

/** How long a move is, counted as the limit counts it. */
export const moveLength = (args: string[]): number => args.join(" ").length;
