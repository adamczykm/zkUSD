// lightnet.ts
import { spawn } from 'child_process';

export interface LightnetOptions {
  /**
   * Poll interval in seconds (default = 5s).
   */
  pollIntervalSeconds?: number;

  /**
   * Maximum total waiting time in seconds (default = 60s).
   */
  maxWaitTimeSeconds?: number;
}

/**
 * A helper function to run a shell command (e.g. "zk lightnet start")
 * and gather output. Returns a Promise that resolves with the exit code,
 * stdout, and stderr.
 */
async function runCommand(
  command: string,
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin, collect stdout/stderr
      shell: false,
    });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      // This event fires if the command itself couldn't be spawned
      // (e.g. "zk" is not in PATH).
      reject(err);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Starts the lightnet if it’s not already started, then waits until it is ready,
 * blocking further execution until successful or until timeout.
 *
 * The logic is:
 * 1. Check "zk lightnet status":
 *    - code = 0 => might be up, or might have exited. Check output:
 *         - If "Is running: false" => treat as error => lightnet not running
 *         - Otherwise => already up => done
 *    - code = 1 => not ready => run "zk lightnet start", then poll status
 *    - otherwise => treat as error
 * 2. When running "zk lightnet start":
 *    - code = 127 => "zk" not found => throw error
 *    - code != 0 => treat as error
 *    - code = 0 => poll "zk lightnet status" until code = 0 and "Is running: true"
 *      or we time out.
 */
export async function ensureLightnetRunning(
  options: LightnetOptions = {}
): Promise<void> {

  console.log('[lightnet-boot] Checking current status: "zk lightnet status"');
  const initialStatus = await runCommand('zk', ['lightnet', 'status']);
  const initialCode = initialStatus.code ?? -1;
  const initialOut = initialStatus.stdout;

  // Check the code first
  if (initialCode === 0) {
    // The lightnet might be running OR might have exited but the command exited cleanly (0).
    if (isLightnetNotRunning(initialOut)) {
      // "Is running: false" means it's actually not running.
      console.error('[lightnet-boot] Lightnet is not running, but status returned code 0.');
      console.error('[lightnet-boot] stdout:', initialOut);
      console.error('[lightnet-boot] stderr:', initialStatus.stderr);
      throw new Error('Lightnet is not running (exited). Cannot proceed.');
    } else {
      // "Is running: true" or at least not "Is running: false"
      console.log('[lightnet-boot] Lightnet is already running (status code 0).');
      return;
    }
  }

  if (initialCode === 1) {
    // Not ready => attempt to start
    console.log('[lightnet-boot] Lightnet not ready (status code 1). Attempting to start...');
    await startLightnetAndWait(options);
    return;
  }

  // Any other non-zero exit code means an error from "zk lightnet status"
  console.error(
    `[lightnet-boot] "zk lightnet status" failed with code: ${initialCode}`
  );
  console.error('[lightnet-boot] stdout:', initialOut);
  console.error('[lightnet-boot] stderr:', initialStatus.stderr);
  throw new Error(`Unexpected code from "zk lightnet status": ${initialCode}`);
}

/**
 * Run "zk lightnet start", wait for it to terminate, then poll status
 * until ready (i.e. status code = 0 and "Is running: true") or we time out.
 */
async function startLightnetAndWait(options: LightnetOptions) {
  const {
    pollIntervalSeconds = 5,
    maxWaitTimeSeconds = 300,
  } = options;

  console.log('[lightnet-boot] Starting the lightnet: "zk lightnet start"');
  const startResult = await runCommand('zk', ['lightnet', 'start']);

  // Handle exit code of the start command
  if (startResult.code === 127) {
    console.error('[lightnet-boot] The "zk" command was not found in PATH.');
    console.error('[lightnet-boot] stderr:', startResult.stderr);
    throw new Error('Missing "zk" command (exit code 127).');
  } else if (startResult.code !== 0) {
    console.error(
      `[lightnet-boot] "zk lightnet start" finished with code: ${startResult.code}`
    );
  }

  console.log('[lightnet-boot] "zk lightnet start" completed. Proceeding to poll status...');

  const startTime = Date.now();
  const pollIntervalMs = pollIntervalSeconds * 1000;
  const maxWaitTimeMs = maxWaitTimeSeconds * 1000;

  // Poll in a loop
  while (true) {
    const statusResult = await runCommand('zk', ['lightnet', 'status']);
    const statusCode = statusResult.code ?? -1;
    const statusOut = statusResult.stdout;
    const elapsed = Date.now() - startTime;

    // status code = 0 => either running or exited
    if (statusCode === 0) {
      if (isLightnetNotRunning(statusOut)) {
        // "Is running: false" => means it has exited
        console.error('[lightnet-boot] Lightnet is not running (exited) despite code 0.');
        console.error('[lightnet-boot] stdout:', statusOut);
        console.error('[lightnet-boot] stderr:', statusResult.stderr);
        throw new Error('Lightnet has exited. Could not start properly.');
      } else {
        // Running
        console.log('[lightnet-boot] Lightnet is up and running!');
        break;
      }
    }

    // code = 1 => Not ready yet => keep polling
    if (statusCode === 1) {
      if (elapsed > maxWaitTimeMs) {
        console.error('[lightnet-boot] Timed out waiting for the lightnet to be ready.');
        console.error('[lightnet-boot] Last stdout:', statusOut);
        console.error('[lightnet-boot] Last stderr:', statusResult.stderr);
        throw new Error('Timeout: Lightnet not ready within the allotted time.');
      }
      console.log(
        `[lightnet-boot] Lightnet not ready (status code 1). Will retry in ${pollIntervalSeconds}s...`
      );
      await sleep(pollIntervalMs);
      continue;
    }

    // Any other non-zero code is treated as an error
    console.error(
      `[lightnet-boot] Unexpected exit code from "zk lightnet status": ${statusCode}`
    );
    console.error('[lightnet-boot] stdout:', statusOut);
    console.error('[lightnet-boot] stderr:', statusResult.stderr);
    throw new Error(`Failed to get a valid status (code: ${statusCode}).`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks status output for the substring "Is running: false".
 * Returns `true` if the substring is found, indicating Lightnet is NOT running.
 */
function isLightnetNotRunning(statusOutput: string): boolean {
  return statusOutput.includes('Is running: false');
}
