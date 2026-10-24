// Slash commands in chat. A message that starts with '/' is a command unless it
// starts with '//', which sends the rest (one slash shorter) as plain text.
// Pure: no I/O, so the server and the web UI can both route with it.

export const COMMANDS_HINT = '/chat N (or /c N) · /start · /stop';

const UNKNOWN_HINT = 'Commands: /chat N (or /c N), /start, /stop. Start with // to send a message that begins with /.';
const CHAT_USAGE = 'Use /chat N <message>, where N is a connection\'s number.';

const fail = (error) => ({ kind: 'error', error });

export function parseCommand(text) {
  const input = String(text).trimStart();
  if (!input.startsWith('/')) return { kind: 'say', text: input };
  if (input.startsWith('//')) return { kind: 'say', text: input.slice(1) };

  // The command word runs to the first whitespace; the rest is its argument.
  const [, word, rest] = /^\/(\S*)([\s\S]*)$/.exec(input);
  const args = rest.trim();

  switch (word.toLowerCase()) {
    case 'chat':
    case 'c': {
      if (!args) return fail(CHAT_USAGE);
      const [, num, message] = /^(\S+)([\s\S]*)$/.exec(args);
      if (!/^[1-9]\d*$/.test(num)) return fail(CHAT_USAGE);
      const body = message.trim();
      if (!body) return fail('Add a message after /chat N.');
      return { kind: 'chat', n: Number(num), text: body };
    }
    case 'start':
      if (!args) return fail('Add a kickoff message after /start.');
      return { kind: 'start', text: args };
    case 'stop':
      if (args) return fail('/stop takes no message.');
      return { kind: 'stop' };
    default:
      return fail(`Unknown command /${word}. ${UNKNOWN_HINT}`);
  }
}
