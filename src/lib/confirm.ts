/**
 * @fileoverview Shared interactive confirmation prompt for destructive/overwrite
 * operations. No external dependency — uses Node's built-in readline/promises.
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

interface ConfirmOptions {
  assumeYes?: boolean;
}

/**
 * Prompts the user with a y/N question before a destructive action.
 * Fails closed (returns false) when running non-interactively without
 * assumeYes, instead of hanging on stdin that will never arrive.
 * @param message - Question to show (without the "[y/N]" suffix)
 * @param options
 * @returns True if the action should proceed
 */
async function confirmAction(
  message: string,
  { assumeYes = false }: ConfirmOptions = {}
): Promise<boolean> {
  if (assumeYes) return true;

  if (!input.isTTY) {
    console.error(`${message} — not running in an interactive terminal and no --yes/--force given; aborting for safety.`);
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export { confirmAction };
