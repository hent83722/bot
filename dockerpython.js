const { spawn } = require('child_process');

const TIMEOUT_MS = 3000;
const MAX_OUTPUT = 1500;

function runPythonDocker(code) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run',
      '-i',
      '--rm',
      '--network=none',
      '--memory=64m',
      '--cpus=0.5',
      'python:3.12-alpine',
      'python3',
      '-u',   
      '-'
    ]);

    let stdout = '';
    let stderr = '';
    let finished = false;

    const killTimer = setTimeout(() => {
      if (!finished) {
        docker.kill('SIGKILL');
        resolve('Python execution timed out.');
      }
    }, TIMEOUT_MS);

    docker.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + '\n...truncated';
      }
    });

    docker.stderr.on('data', d => {
      stderr += d.toString();
    });

    docker.on('close', () => {
      finished = true;
      clearTimeout(killTimer);

      if (stderr.trim()) {
        resolve(`Python error:\n\`\`\`\n${stderr.slice(0, MAX_OUTPUT)}\n\`\`\``);
      } else if (stdout.trim()) {
        resolve(`Output:\n\`\`\`\n${stdout}\n\`\`\``);
      } else {
        resolve('Python ran but produced no output.');
      }
    });

    docker.stdin.write(code + '\n'); 
    docker.stdin.end();
  });
}

module.exports = { runPythonDocker };
