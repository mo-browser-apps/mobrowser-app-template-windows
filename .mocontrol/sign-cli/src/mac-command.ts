import { spawn, type ChildProcess } from 'node:child_process';

import { throwIfReleaseInterrupted } from './common/release-interruption.js';

export type MacCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  captureOutput?: boolean;
  input?: string;
  /** Reserved for cleanup that must run after the release interruption flag is set. */
  allowDuringInterruption?: boolean;
};

export type MacCommandResult = { stdout: string; stderr: string };

type ActiveMacCommand = {
  child: ChildProcess;
  termination?: Promise<void>;
};

const activeMacCommands = new Map<number, ActiveMacCommand>();

/** Runs one macOS tool with argument-array escaping and optional captured output. */
export async function runMacCommand(
  command: string,
  args: string[],
  options: MacCommandOptions = {},
): Promise<MacCommandResult> {
  if (options.allowDuringInterruption !== true) {
    throwIfReleaseInterrupted();
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // A separate POSIX process group lets interruption terminate npm and all
      // build/package descendants before signing credentials are removed.
      detached: process.platform !== 'win32',
      stdio:
        options.captureOutput === true
          ? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
          : [options.input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const activeCommand: ActiveMacCommand = { child };
    if (child.pid !== undefined) {
      activeMacCommands.set(child.pid, activeCommand);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.end(options.input);
    }
    child.on('error', (error) => {
      removeActiveMacCommand(child);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code, signal) => {
      removeActiveMacCommand(child);
      void (async () => {
        try {
          await activeCommand.termination;
          if (options.allowDuringInterruption !== true) {
            throwIfReleaseInterrupted();
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        if (code === 0) {
          resolvePromise({ stdout, stderr });
        } else {
          const termination =
            signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`;
          reject(
            new Error(
              `${command} failed with ${termination}${stderr.length > 0 ? `: ${stderr.trim()}` : ''}`,
            ),
          );
        }
      })();
    });
  });
}

/** Terminates every active macOS command process group and waits for all descendants. */
export function terminateActiveMacCommandTrees(
  signal: NodeJS.Signals = 'SIGTERM',
  timeoutMs = 5_000,
): Promise<void> {
  const commands = [...activeMacCommands.values()];
  const termination = terminateMacCommandTrees(commands, signal, timeoutMs);
  for (const command of commands) {
    command.termination = termination;
  }
  return termination;
}

async function terminateMacCommandTrees(
  commands: ActiveMacCommand[],
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  for (const command of commands) {
    signalMacCommandTree(command.child, signal);
  }
  let remaining = await waitForMacCommandTreesToExit(commands, timeoutMs);
  if (remaining.length === 0) {
    return;
  }

  for (const command of remaining) {
    signalMacCommandTree(command.child, 'SIGKILL');
  }
  remaining = await waitForMacCommandTreesToExit(remaining, timeoutMs);
  if (remaining.length > 0) {
    const processIds = remaining
      .map(({ child }) => child.pid)
      .filter((pid) => pid !== undefined)
      .join(', ');
    throw new Error(`Could not terminate macOS command process tree(s): ${processIds}.`);
  }
}

async function waitForMacCommandTreesToExit(
  commands: ActiveMacCommand[],
  timeoutMs: number,
): Promise<ActiveMacCommand[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = commands.filter(({ child }) => isMacCommandTreeAlive(child));
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    remaining = remaining.filter(({ child }) => isMacCommandTreeAlive(child));
  }
  return remaining;
}

function signalMacCommandTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

function isMacCommandTreeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

function removeActiveMacCommand(child: ChildProcess): void {
  if (child.pid !== undefined) {
    activeMacCommands.delete(child.pid);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EPERM'
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
