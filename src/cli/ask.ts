import type { Interface } from "node:readline";
import { InterruptedError } from "../errors.js";

/**
 * Ask one question on an open readline interface. Every prompt goes through here.
 *
 * Ctrl-C closes the interface and rejects with InterruptedError. Closing it takes
 * the terminal out of raw mode, so typing shows again after a masked prompt.
 * Ctrl-D, or input that ends, answers with an empty string. Without these two
 * listeners the question never settles, and the process ends with exit code 0 as
 * if the person had answered.
 */
export function ask(rl: Interface, question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    rl.once("SIGINT", () => {
      // Reject first: closing fires the listener below, and only the first call counts.
      reject(new InterruptedError());
      rl.close();
    });
    rl.once("close", () => resolve(""));
    rl.question(question, resolve);
  });
}
