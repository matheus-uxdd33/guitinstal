'use strict';

/**
 * Recognises the moment a command stops to ask a question.
 *
 * A command that asks needs an answer, so the app must know it is waiting:
 * these patterns decide when a step shows the answer box instead of looking
 * like a command that is silently doing nothing. Only the end of a line
 * counts, so ordinary log text that mentions "y/n" does not open the box.
 */

const PATTERNS = [
  /\((?:y\/n|n\/y|yes\/no)\)\s*:?\s*\??\s*$/i,
  /\[(?:y\/n|n\/y|yes\/no|y|n)\]\s*:?\s*\??\s*$/i,
  /are you sure[^\n]*\?\s*$/i,
  /(?:press|hit) (?:any key|enter)/i,
  /do you want to[^\n]*\?\s*$/i,
  /overwrite[^\n]*\?\s*$/i,
  /replace[^\n]*\?\s*$/i,
  /continue[^\n]*\?\s*$/i,
  /(?:password|passphrase|secret|token)[^\n]*:\s*$/i,
  /(?:username|login|e-?mail)[^\n]*:\s*$/i,
  /^\s*[?❯]\s+\S[^\n]*\?\s*$/,
];

/** The line when it is a question, otherwise an empty string. */
function promptLine(line) {
  const text = String(line || '').trim();
  if (!text || text.length > 300) return '';
  return PATTERNS.some((pattern) => pattern.test(text)) ? text : '';
}

/** Newest question in a list of output lines, or an empty string. */
function detectPrompt(lines) {
  for (let index = (lines?.length || 0) - 1; index >= 0; index -= 1) {
    const found = promptLine(lines[index]);
    if (found) return found;
  }
  return '';
}

/**
 * Plain English for a question the user has never seen before. A command that
 * asks is only a dead end when the person cannot tell what they are agreeing
 * to, so every recognised question also says what each answer does. `answer`
 * is what the input box starts with; it is empty wherever a real choice or a
 * secret is involved.
 */
const EXPLANATIONS = [
  {
    pattern: /are you sure/i,
    hint: 'A delete step wants confirmation before it removes the files it just listed. Y lets the build continue, N keeps them and stops.',
    answer: 'Y',
  },
  {
    pattern: /password|passphrase|secret|token/i,
    hint: 'It is asking for a credential. Whatever you type is shown on this screen and saved with the run log, so type it only if that is acceptable; otherwise use Stop and run the command in a terminal yourself.',
    answer: '',
  },
  {
    pattern: /username|login|e-?mail/i,
    hint: 'It is asking who you are. The account name the command expects is usually your GitHub user name.',
    answer: '',
  },
  {
    pattern: /(?:press|hit) (?:any key|enter)/i,
    hint: 'It only waits for the keyboard. Press "Send answer" to continue.',
    answer: '',
  },
  {
    pattern: /overwrite|replace/i,
    hint: 'It asks whether a file that already exists may be replaced. Y replaces it, N keeps the copy you have.',
    answer: '',
  },
  {
    pattern: /(?:\(|\[)\s*y\s*\/\s*n|(?:\(|\[)\s*n\s*\/\s*y|yes\/no/i,
    hint: 'A yes-or-no choice. Type Y to accept or N to decline.',
    answer: 'Y',
  },
  {
    pattern: /do you want to|continue/i,
    hint: 'The command asks permission to carry on with its own work. Y continues, N stops this step.',
    answer: 'Y',
  },
];

/** @returns {{ hint: string, answer: string }} */
function explainPrompt(text) {
  const value = String(text || '');
  for (const item of EXPLANATIONS) {
    if (item.pattern.test(value)) return { hint: item.hint, answer: item.answer };
  }
  return {
    hint: 'The command stopped and asked this question. It does not move until you send an answer.',
    answer: '',
  };
}

module.exports = { detectPrompt, explainPrompt, promptLine };
