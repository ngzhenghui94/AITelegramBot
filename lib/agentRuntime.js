import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, posix } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'telegram-omp-agent:local';
const SEARCH_KEYS = ['EXA_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY'];

function isMissingContainer(error) {
  return /no such (container|object)/i.test(String(error.stderr || ''));
}

function positiveNumber(name, fallback, integer = false) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}.`);
  }
  return value;
}

export function agentConfig() {
  return {
    stateDir: resolve(process.env.OMP_STATE_DIR || '.agent-state'),
    timeoutMs: positiveNumber('OMP_TASK_TIMEOUT_MS', 600_000, true),
    approvalTimeoutMs: positiveNumber('OMP_APPROVAL_TIMEOUT_MS', 120_000, true),
  };
}

function imageName() {
  const image = process.env.OMP_DOCKER_IMAGE || DEFAULT_IMAGE;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(image)) {
    throw new Error('OMP_DOCKER_IMAGE must be a Docker image reference.');
  }
  return image;
}

// The Docker client needs its connection settings, not the bot's entire environment.
function dockerEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export async function checkAgentRuntime() {
  agentConfig();
  positiveNumber('OMP_MAX_COST_USD', 5);
  try {
    await execFileAsync('docker', ['image', 'inspect', imageName()], {
      env: dockerEnvironment(), timeout: 20_000, maxBuffer: 1_048_576,
    });
  } catch {
    throw new Error('OMP container image is unavailable. Start Docker and run npm run setup-agent.');
  }
}

export function launchAgent({ chatId, sessionFile } = {}) {
  if (!/^[1-9]\d*$/.test(String(chatId))) {
    throw new Error('OMP requires a positive numeric private chat ID.');
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY for OMP.');
  if (sessionFile && (!sessionFile.startsWith('/home/agent/sessions/') || posix.normalize(sessionFile) !== sessionFile)) {
    throw new Error('Invalid OMP session path.');
  }

  const name = `telegram-omp-${chatId}-${randomUUID()}`;
  const env = dockerEnvironment();
  const args = [
    'run', '--rm', '--interactive', '--init', '--sig-proxy=false', '--name', name,
    '--label', 'app=telegram-omp-agent',
    '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=536870912,uid=10001,gid=10001',
    '--mount', `type=volume,src=telegram-omp-home-${chatId},dst=/home/agent`,
    '--mount', `type=volume,src=telegram-omp-workspace-${chatId},dst=/workspace`,
  ];
  for (const key of ['OPENAI_API_KEY', ...SEARCH_KEYS]) {
    if (!process.env[key]) continue;
    env[key] = process.env[key];
    args.push('--env', key);
  }
  args.push(imageName(),
    '--mode', 'rpc-ui', '--approval-mode', 'always-ask',
    '--session-dir', '/home/agent/sessions',
    '--no-extensions', '--no-skills', '--no-rules', '--no-context-files',
    '--max-cost', String(positiveNumber('OMP_MAX_COST_USD', 5)),
  );
  if (sessionFile) {
    args.push('--resume', sessionFile);
  } else {
    const configuredModel = process.env.AI_MODEL || 'gpt-6.1-sol';
    args.push('--model', configuredModel.includes('/') ? configuredModel : `openai/${configuredModel}`);
  }

  const child = spawn('docker', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.containerName = name;
  const exited = new Promise((done) => {
    child.once('close', done);
    child.once('error', done);
  });
  let termination;
  child.terminate = () => {
    termination ||= (async () => {
      // Stop the client first, including when cancellation races container startup.
      // Do not forward this signal to OMP: rm --force below stops the whole tree.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      try {
        await execFileAsync('docker', ['rm', '--force', name], {
          env: dockerEnvironment(), timeout: 15_000, maxBuffer: 65_536,
        });
      } catch (error) {
        // Docker's --rm cleanup can win the race with explicit removal. An
        // ambiguous removal error is safe only if inspection proves it is gone.
        let removed = isMissingContainer(error);
        if (!removed) {
          try {
            await execFileAsync('docker', ['container', 'inspect', '--format', '{{.State.Status}}', name], {
              env: dockerEnvironment(), timeout: 15_000, maxBuffer: 65_536,
            });
          } catch (inspectionError) {
            removed = isMissingContainer(inspectionError);
          }
        }
        if (!removed) {
          throw new Error(`Could not stop OMP worker ${name}; inspect it with docker ps.`);
        }
      } finally {
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    })();
    return termination;
  };
  return child;
}
