// What's typed in the chat box and not sent yet. It lives here, not in the chat component,
// so switching tabs (which removes the docked chat) or popping the chat out keeps it.
export const chatDraft = $state({ text: '' });
