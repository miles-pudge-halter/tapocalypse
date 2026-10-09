import type { HarnessSession, SessionInfo } from "./types";

/**
 * A session whose process could not be started (spawn throw, invalid settings): `ready` and `send` reject with `message`
 * and `exited` already reports a session that never ran, which the runner classifies as a retriable infra failure.
 */
export function failedSession(message: string, toolName: HarnessSession["toolName"]): HarnessSession {
  const failure = Promise.reject<SessionInfo>(new Error(message));
  failure.catch(() => {});
  return {
    ready: () => failure,
    toolName,
    send: () => Promise.reject(new Error(message)),
    abort: async () => {},
    kill: () => {},
    usage: async () => null,
    exited: Promise.resolve({ code: 127, signal: null, settled: false, started: false, limit: null, error: message }),
  };
}
