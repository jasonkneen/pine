/**
 * Agents introduce themselves, once each.
 *
 * No agent starts a conversation: pine sends no model anything by itself. An agent introduces
 * itself in its answer to the first message its owner writes to it (`INTRODUCE`, put into the
 * note in front of that message), the main agent too.
 *
 * Who may do what:
 * - A run started from outside never introduces itself and never counts as the first meeting:
 *   only a message of the owner's does (kind "prompt", trust "owner").
 * - It happens once per agent, kept in pine's database (kv `introduced:<agent>`), and only when
 *   the turn ended well: a model that failed has not met anybody.
 */

export const introducedKey = (agent: string) => `introduced:${agent}`;

/** Put into the note in front of the owner's first message to an agent. */
export const INTRODUCE =
	"This is the first time your owner writes to you. Begin your answer by introducing yourself in two or three sentences: your name, what you are for (your instructions say it), and what you can do for them. Then answer their message.";
