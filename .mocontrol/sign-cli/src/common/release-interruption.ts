export type ReleaseInterruptionHandler = (signal: NodeJS.Signals) => Promise<void>;

export class ReleaseInterruptedError extends Error {
  public constructor(public readonly signal: NodeJS.Signals) {
    super(`Release interrupted by ${signal}.`);
    this.name = 'ReleaseInterruptedError';
  }
}

type ActiveReleaseInterruption = {
  error?: ReleaseInterruptedError;
  handlers: Set<ReleaseInterruptionHandler>;
};

const releaseSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let activeRelease: ActiveReleaseInterruption | undefined;

/** Installs one process-wide interruption scope for the active release command. */
export function installReleaseInterruptionHandlers(): () => void {
  if (activeRelease !== undefined) {
    throw new Error('A release interruption scope is already active in this process.');
  }

  const release: ActiveReleaseInterruption = { handlers: new Set() };
  activeRelease = release;
  const listeners = releaseSignals.map((signal) => {
    const listener = () => requestActiveReleaseInterruption(signal);
    process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
    if (activeRelease === release) {
      activeRelease = undefined;
    }
  };
}

/** Requests the same orderly cancellation path used by OS process signals. */
export function requestActiveReleaseInterruption(signal: NodeJS.Signals): void {
  const release = activeRelease;
  if (release === undefined || release.error !== undefined) {
    return;
  }

  release.error = new ReleaseInterruptedError(signal);
  process.exitCode = signalExitCode(signal);
  for (const handler of [...release.handlers]) {
    void handler(signal).catch((error: unknown) => {
      console.error(`Warning: interruption cleanup failed: ${errorMessage(error)}`);
    });
  }
}

/** Registers process-tree cancellation for work currently owned by the release. */
export function registerReleaseInterruptionHandler(
  handler: ReleaseInterruptionHandler,
): () => void {
  const release = activeRelease;
  if (release === undefined) {
    return () => undefined;
  }
  release.handlers.add(handler);
  return () => release.handlers.delete(handler);
}

/** Prevents new release work from starting after a handled process signal. */
export function throwIfReleaseInterrupted(): void {
  if (activeRelease?.error !== undefined) {
    throw activeRelease.error;
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGHUP') {
    return 129;
  }
  return signal === 'SIGINT' ? 130 : 143;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
