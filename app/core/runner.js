'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { explainPrompt, promptLine } = require('./prompts');
const { effectivePath, forgetToolLookups, installHint, resolveTool, runtimeFor } = require('./tools');
const { toolEnv } = require('./runtime-install');
const { recheckCloneStep } = require('./plan');

/**
 * Execution engine.
 *
 * Rules that never bend:
 *  - a step runs only after it was explicitly approved;
 *  - commands are spawned with an argument array and without a shell, so
 *    repository content can never be interpreted as shell syntax;
 *  - every byte of output is streamed to the UI as it arrives;
 *  - a command that asks a question keeps a real stdin, so the answer can
 *    still be typed.
 */

const MAX_LINES_PER_STEP = 400;

/**
 * The one line a failed command printed that actually explains itself.
 * "Exited with code 128" is not a sentence a user can act on; the "fatal:"
 * line git wrote next to it is.
 */
const EXPLAINS = /(fatal:|error|failed|denied|refused|not found|no such|cannot|inaccessible|unauthorized|permission|missing)/i;
// Every tool closes its failure with a footer pointing at a log file or a hint
// for what to try next. That footer is the last line, so reading the last
// matching line quoted it instead of the reason.
const FOOTER =
  /(complete log|can be found in|full output|verbose run|for a full report|run `|see .*--help|note that you can also|^\s*(tip|note|hint):|^\s*\^+\s*$|https?:\/\/\S+\s*$)/i;
// Messages that name the thing that is missing, which is what a person acts on.
// Tool output wraps, so a line can be the tail of a sentence that started two
// lines above: preferring the line that carries a quoted name beats guessing
// with position alone.
const NAMES_IT =
  /('[^']{3,}'|"[^"]{3,}"|is not recognized|cannot find|no such file|permission denied|authentication|access is denied|ERESOLVE|ETIMEDOUT|ENOTFOUND|ENOENT|EACCES|command not found|fatal:|error [A-Z]+\d+|gyp ERR!)/i;

function failureReason(step) {
  const lines = (step.output || []).map((entry) => String(entry.text || '').trim()).filter(Boolean);
  if (!lines.length) return '';
  // Rust on Windows links through a C++ toolchain. The GNU toolchain rustup
  // installs expects an x86-64 assembler for its import libraries; an old 32-bit
  // MinGW on PATH produces "Invalid bfd target", and without any assembler the
  // step dies with a bare "CreateProcess". Neither tells a person what to do.
  if (lines.some((line) => /dlltool|invalid bfd target|could not create import library/i.test(line))) {
    return 'Rust itself installed, but this project needs a Windows C++ linker that this machine does not have: the Rust compiler could not build its Windows import libraries with the toolchain it found. Install "Build Tools for Visual Studio" with the Desktop development with C++ workload, then run this step again. Nothing was lost: the repository is cloned and the Rust toolchain is kept inside GUITinstal.';
  }
  const candidates = lines.filter((line) => EXPLAINS.test(line) && !FOOTER.test(line));
  const fromEnd = (list) => [...list].reverse().find(Boolean);
  const hit =
    fromEnd(candidates.filter((line) => NAMES_IT.test(line))) ||
    fromEnd(candidates) ||
    fromEnd(lines.filter((line) => !FOOTER.test(line))) ||
    lines[lines.length - 1];
  const clean = String(hit || '').replace(/\s+/g, ' ');
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

/** Last lines of a launcher log, used to explain an immediate crash. */
function readLogTail(logPath, lines = 12) {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const tail = content.split(/\r?\n/).filter((line) => line.trim().length).slice(-lines);
    return tail.join('\n');
  } catch {
    return '';
  }
}

/**
 * Text a log gained after a byte offset. Launch logs are appended to across
 * runs, so reading the whole tail can report a port from a previous run.
 */
function readLogFrom(logPath, fromByte = 0, lines = 80) {
  try {
    const size = fs.statSync(logPath).size;
    if (size <= fromByte) return '';
    const start = Math.max(fromByte, size - 256 * 1024);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().length)
        .slice(-lines)
        .join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Size a log already had, so only what the next launch writes is read. */
function logSize(logPath) {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
}

/**
 * Launch logs are appended to across runs, so the first address in a tail can
 * be a port a dev server used in an earlier run and is now dead. Newest line wins.
 */
function findLatestLocalUrl(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const url = findLocalUrl(lines[i]);
    if (url) return url;
  }
  return '';
}

function findLocalUrl(text) {
  const raw = String(text || '');
  const match = raw.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s]*)?/i);
  if (match) {
    try {
      const url = new URL(match[0].replace(/[),.]+$/, ''));
      if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
      if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) > 65535) return '';
      return url.toString();
    } catch {
      return '';
    }
  }

  // Plenty of projects log only the port ("Example app listening on port 3001").
  // Without that number the Run button starts the app and then cannot show the
  // Open app link, so a listening phrase that names a port becomes an address.
  // The port word (or a host:/port pair) is required, so "started 12 workers"
  // and "EADDRINUSE ... :::3001" stay out of the address bar.
  const portOnly = raw.match(
    /(?:listen|listening|running|serving|start(?:ing|ed)?)[^\n]{0,40}?(?:\bport\b\s*[:=]?\s*|\*\s*:\s*|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)(\d{2,5})\b/i,
  );
  if (!portOnly) return '';
  const port = Number(portOnly[1]);
  if (port < 1 || port > 65535) return '';
  return `http://127.0.0.1:${port}/`;
}

/**
 * The install record: every command the app ran for this repository, in order,
 * with its exit code and output. It lives inside the project folder so the
 * history survives the app, the run and the machine's restarts.
 */
function writeInstallLog(run) {
  // A run cancelled before its clone has no project folder. Creating one just to
  // file a log would leave a plain directory in the workspace, and the next
  // install of that repository would then stop at "folder exists, not a Git repo".
  if (!fs.existsSync(run.plan.directory)) return '';
  const dir = path.join(run.plan.directory, '.guitinstal');
  const file = path.join(dir, 'install.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      `# GUITinstal install ${run.createdAt}`,
      `repository: ${run.plan.repo.fullName}`,
      `stack: ${run.plan.stack.label}`,
      `directory: ${run.plan.directory}`,
      `result: ${run.status} ${run.endedAt || new Date().toISOString()}`,
      '',
    ];
    for (const step of run.steps) {
      lines.push(`$ ${step.command}  [${step.status}]${step.exitCode === null || step.exitCode === undefined ? '' : ` exit ${step.exitCode}`}`);
      if (step.error) lines.push(`! ${step.error}`);
      for (const item of step.output.slice(-200)) lines.push(`  ${item.text}`);
      lines.push('');
    }
    fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return file;
  } catch {
    return '';
  }
}

class RunManager {
  constructor() {
    this.runs = new Map();
  }

  list() {
    return [...this.runs.values()];
  }

  get(runId) {
    return this.runs.get(runId) || null;
  }

  /** Creates a run from a plan. No step executes yet. */
  create(plan, { workspace }) {
    const run = {
      id: `run-${crypto.randomUUID().slice(0, 8)}`,
      plan,
      workspace,
      status: 'awaiting-approval',
      createdAt: new Date().toISOString(),
      endedAt: null,
      currentStepId: null,
      installLog: '',
      verification: null,
      library: null,
      steps: plan.steps.map((item) => ({
        ...item,
        status: 'pending',
        approved: false,
        exitCode: null,
        startedAt: null,
        endedAt: null,
        output: [],
        error: null,
        prompt: '',
        promptHint: '',
        promptAnswer: '',
        awaitingInput: false,
      })),
      listeners: new Set(),
    };

    run.steps[0].status = 'awaiting-approval';
    run.currentStepId = run.steps[0].id;
    this.runs.set(run.id, run);
    this.emit(run);
    return run;
  }

  subscribe(runId, listener) {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.listeners.add(listener);
    listener(this.snapshot(run));
    return () => run.listeners.delete(listener);
  }

  snapshot(run) {
    return {
      id: run.id,
      planId: run.plan.id,
      repo: run.plan.repo,
      stack: run.plan.stack,
      directory: run.plan.directory,
      status: run.status,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      currentStepId: run.currentStepId,
      installLog: run.installLog,
      verification: run.verification || null,
      library: run.library || null,
      steps: run.steps.map((step) => ({
        id: step.id,
        index: step.index,
        title: step.title,
        purpose: step.purpose,
        command: step.command,
        notes: step.notes,
        risk: step.risk,
        optional: step.optional,
        autoApprovable: step.autoApprovable,
        status: step.status,
        approved: step.approved,
        exitCode: step.exitCode,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        error: step.error,
        notes: step.notes,
        prompt: step.prompt,
        promptHint: step.promptHint,
        promptAnswer: step.promptAnswer,
        awaitingInput: step.awaitingInput,
        pid: step.pid,
        logPath: step.logPath,
        url: step.url || '',
        output: step.output.slice(-40),
      })),
    };
  }

  emit(run) {
    // The install record is written once, at the moment the run settles, so a
    // finished installation always leaves a readable history behind.
    if (!run.logWritten && (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled')) {
      run.logWritten = true;
      run.installLog = writeInstallLog(run);
    }
    const payload = this.snapshot(run);
    for (const listener of run.listeners) {
      try {
        listener(payload);
      } catch {
        /* a broken listener must not break the run */
      }
    }
  }

  findStep(run, stepId) {
    return run.steps.find((step) => step.id === stepId) || null;
  }

  /** Approves a single step. It starts only if it is the step in focus. */
  approve(runId, stepId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run not found.');
    if (run.status === 'cancelled') throw new Error('This run was cancelled.');

    const step = this.findStep(run, stepId);
    if (!step) throw new Error('Step not found.');
    if (step.status === 'running') throw new Error('This step is already running.');
    if (step.status === 'done' || step.status === 'skipped') {
      throw new Error('This step is already done.');
    }

    step.approved = true;
    step.status = 'approved';
    this.emit(run);

    if (run.currentStepId === step.id) {
      this.execute(run, step);
    } else {
      this.advance(run, step.index);
    }
    return this.snapshot(run);
  }

  /** Approves every pending step at once, in order. */
  approveAll(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run not found.');
    if (run.status === 'cancelled') throw new Error('This run was cancelled.');

    for (const step of run.steps) {
      // "Approve all and install" installs. An optional step such as starting
      // the program stays for the human to approve: it is not needed to install
      // and it can fail for reasons that have nothing to do with the install.
      if (step.optional) continue;
      if (step.status === 'pending' || step.status === 'awaiting-approval' || step.status === 'failed') {
        step.approved = true;
        step.status = 'approved';
      }
    }
    this.emit(run);
    const current = run.steps.find((step) => step.id === run.currentStepId);
    if (current && current.status === 'approved') this.execute(run, current);
    return this.snapshot(run);
  }

  /** Skips a step and moves on to the next one. */
  skip(runId, stepId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run not found.');
    const step = this.findStep(run, stepId);
    if (!step) throw new Error('Step not found.');
    if (step.status === 'running') throw new Error('A running step cannot be skipped.');
    if (step.status === 'done') return this.snapshot(run);

    step.status = 'skipped';
    step.endedAt = new Date().toISOString();
    this.advance(run, step.index);
    return this.snapshot(run);
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run not found.');
    run.status = 'cancelled';
    run.endedAt = new Date().toISOString();
    // A step that is waiting for an answer waits forever unless its process
    // is actually killed, so cancelling has to take the process tree too.
    if (run.child?.pid) killProcessTree(run.child.pid);
    for (const step of run.steps) {
      if (step.status === 'running') {
        step.status = 'cancelled';
        step.awaitingInput = false;
        step.endedAt = new Date().toISOString();
      }
    }
    this.emit(run);
    return this.snapshot(run);
  }

  /**
   * Types an answer into the command that is currently waiting for one.
   * An empty answer sends just the Enter key, which is what "press any key"
   * style prompts need.
   */
  sendInput(runId, text) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('Run not found.');

    const step = run.steps.find((item) => item.id === run.currentStepId);
    const stdin = run.child?.stdin;
    if (!step || step.status !== 'running' || !stdin?.writable) {
      throw new Error('No command is waiting for an answer right now.');
    }

    const answer = String(text ?? '').replace(/\r?\n/g, ' ').trim().slice(0, 200);
    step.awaitingInput = false;
    stdin.write(`${answer}\n`);
    step.output.push({ stream: 'stdin', text: `${answer || '(Enter)'}` });
    this.emit(run);
    return this.snapshot(run);
  }

  /**
   * A dev server can boot slower than the window the background step waits.
   * One more look at the log keeps the run view and the library from calling a
   * tool that is answering on a port "not running".
   */
  recheckAddress(run, step, logPath, logStart) {
    setTimeout(async () => {
      if (step.url) return;
      const found = findLatestLocalUrl(readLogFrom(logPath, logStart));
      if (!found) return;
      const owner = await listeningPid(new URL(found).port);
      step.url = found;
      if (owner) step.pid = owner;
      step.notes = `Running at ${found}${owner ? ` (process ${owner})` : ''}.`;
      this.emit(run);
    }, 4000).unref();
  }

  /**
   * Ends the run. The terminal status is published only after the caller's
   * finishing work (filing the project in the library) has completed, so a
   * snapshot that says "done" always carries the final library entry. Without
   * this, the UI closed its stream on the done frame and kept showing the
   * clone-time "downloaded" status until something reloaded the page.
   */
  settle(run) {
    if (run.status === 'cancelled' || run.settled || run.settling) return;

    const failed = run.steps.find((step) => step.status === 'failed');
    const status = failed ? 'failed' : 'done';
    const publish = () => {
      run.settling = false;
      // A cancel can land while the finishing work is in flight; that verdict
      // wins and must not be overwritten with the status captured above.
      if (run.status === 'cancelled') return;
      run.settled = true;
      run.status = status;
      run.endedAt = new Date().toISOString();
      run.currentStepId = null;
      this.emit(run);
    };

    if (typeof run.beforeSettle !== 'function') {
      publish();
      return;
    }

    run.settling = true;
    Promise.resolve()
      .then(() => run.beforeSettle(status))
      .catch(() => {})
      .then(publish);
  }

  /** Moves the focus to the next step that still has to run. */
  advance(run, fromIndex) {
    if (run.status === 'cancelled') return;

    const rest = run.steps.slice(fromIndex + 1);
    // Optional steps are not part of installing: launching a program after the
    // build is a separate decision. Approving them by default ran `cargo run` on
    // a workspace with a dozen binaries and the install ended in an error after
    // a build that had worked. An optional step nobody approved is skipped.
    for (const step of rest) {
      if (!step.optional || step.approved) continue;
      if (step.status === 'pending' || step.status === 'awaiting-approval') {
        step.status = 'skipped';
        step.notes = step.notes || 'Optional step. Approve it yourself if you want it to run.';
      }
    }

    const next = rest.find(
      (step) => step.status === 'pending' || step.status === 'approved' || step.status === 'awaiting-approval'
    );
    if (!next) {
      this.settle(run);
      return;
    }

    run.currentStepId = next.id;
    // A step already approved by "approve everything" must not wait for a
    // second click, but two commands never run at the same time.
    if (next.approved && !run.steps.some((step) => step.status === 'running')) {
      this.execute(run, next);
      return;
    }

    next.status = 'awaiting-approval';
    run.status = 'awaiting-approval';
    this.emit(run);
  }

  /** Spawns a step. Arguments are passed as an array, never through a shell. */
  execute(run, step) {
    // A step that runs again is a new attempt: the terminal verdict and the
    // final library phase from the previous attempt must not stop this one
    // from settling or being filed. The retry is archived as "downloaded"
    // while it runs, then the final write upgrades the same record.
    if (step.exitCode !== null || step.endedAt) {
      run.settled = false;
      run.settling = false;
      if (run.archive?.phase === 'final') {
        run.archive.phase = 'none';
        run.archive.attempts = 0;
      }
    }

    let exec = step.exec;
    if (!exec || !exec.cmd) {
      step.status = 'skipped';
      step.endedAt = new Date().toISOString();
      this.advance(run, step.index);
      return;
    }

    // A plan is written the moment the link is pasted, so a step that needed a
    // tool that was not installed then carries only its bare name. Once the
    // setup step has put the tool on the machine, resolve it again: Windows
    // cannot spawn a bare "composer", and a .cmd would need a shell.
    if (!path.dirname(exec.cmd)) {
      const fresh = resolveTool(exec.cmd);
      if (!fresh.missing) {
        exec = { ...exec, cmd: fresh.cmd, args: fresh.args.concat(exec.args || []), shell: fresh.shell === true };
        // The library stores the launch profile from this step. Keeping only
        // the local variable would save the bare "php" it had before the
        // Runtime Manager installed PHP, and Run would fail after a restart.
        step.exec = exec;
      }
    }

    // The plan was written when the link was pasted. If the folder it targets
    // appeared since then, a second approval must not clone into it again.
    const recheck = recheckCloneStep(step);
    if (recheck) {
      step.status = recheck.status;
      step.endedAt = new Date().toISOString();
      if (recheck.notes) step.notes = recheck.notes;
      if (recheck.error) step.error = recheck.error;
      if (recheck.status === 'failed') {
        run.status = 'failed';
        run.endedAt = new Date().toISOString();
        this.emit(run);
        return;
      }
      this.emit(run);
      this.advance(run, step.index);
      return;
    }

    const cwd = step.cwd === 'workspace' ? run.workspace : run.plan.directory;
    const isBackground = step.id === 'launch' || step.detached === true;

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    step.output = [];
    // A re-run must not keep the previous verdict on screen: a card that says
    // "running" next to "Exited with code 128" reads as a broken tool.
    step.error = null;
    step.exitCode = null;
    step.prompt = null;
    run.status = 'running';
    run.currentStepId = step.id;
    this.emit(run);

    let child;
    let logPath = null;
    let logFd = null;
    let logStart = 0;

    if (isBackground) {
      // A launcher keeps running, so its output goes to a file that the user
      // (and the UI) can read after the process is gone.
      try {
        const logDir = path.join(run.plan.directory, '.guitinstal');
        fs.mkdirSync(logDir, { recursive: true });
        logPath = path.join(logDir, `${step.id}.log`);
        logStart = logSize(logPath);
        logFd = fs.openSync(logPath, 'a');
      } catch {
        logPath = null;
      }
    }

    try {
      child = spawn(exec.cmd, exec.args || [], {
        cwd,
        shell: exec.shell === true,
        // A detached child gets its own console on Windows, and npm starts the
        // script inside a cmd.exe there: the user sees a black window for a tool
        // they never asked to look at. Measured: non-detached + windowsHide keeps
        // the server running and outliving the app, with no window at all.
        windowsHide: true,
        detached: isBackground && process.platform !== 'win32',
        stdio: isBackground
          ? ['ignore', logFd ?? 'ignore', logFd ?? 'ignore']
          : ['pipe', 'pipe', 'pipe'],
        // toolEnv() is what makes a managed JDK, Go tree, Rust home or Python
        // usable: PATH only finds the executable, the tool still needs
        // JAVA_HOME / GOROOT / CARGO_HOME to do its job.
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          GIT_TERMINAL_PROMPT: '0',
          PATH: effectivePath(),
          ...toolEnv(),
          ...(exec.env || {}),
        },
      });
    } catch (error) {
      if (logFd !== null) fs.closeSync(logFd);
      step.status = 'failed';
      step.error = error.message;
      step.endedAt = new Date().toISOString();
      run.status = 'failed';
      this.emit(run);
      return;
    }

    run.child = child;

    const buffers = { stdout: '', stderr: '' };

    const pushLine = (stream, text) => {
      step.output.push({ stream, text });
      const question = promptLine(text);
      if (question && !isBackground) {
        const explained = explainPrompt(question);
        step.prompt = question;
        step.promptHint = explained.hint;
        step.promptAnswer = explained.answer;
        step.awaitingInput = true;
      }
    };

    const append = (stream, text) => {
      const combined = buffers[stream] + text;
      const lines = combined.split(/\r?\n/);
      buffers[stream] = lines.pop() || '';
      for (const line of lines) {
        if (line.length) pushLine(stream, line);
      }
      // A question usually arrives with no line break at all: the command
      // waits with the cursor right after the "?". Reading the tail too is
      // the only way the UI learns that an answer is expected.
      if (buffers[stream] && promptLine(buffers[stream])) {
        pushLine(stream, buffers[stream]);
        buffers[stream] = '';
      }
      if (step.output.length > MAX_LINES_PER_STEP) {
        step.output = step.output.slice(-MAX_LINES_PER_STEP);
      }
      this.emit(run);
    };

    const flushTails = () => {
      for (const stream of ['stdout', 'stderr']) {
        const rest = buffers[stream].trim();
        if (rest) pushLine(stream, rest);
        buffers[stream] = '';
      }
    };

    if (!isBackground) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => append('stdout', chunk));
      child.stderr?.on('data', (chunk) => append('stderr', chunk));
    }

    child.on('error', (error) => {
      flushTails();
      step.status = 'failed';
      step.awaitingInput = false;
      // ENOENT here always means the same thing: the tool the plan asked for
      // is not on this machine. Say that, say where to get it, and say that the
      // Re-check button will pick it up without restarting the app.
      if (error.code === 'ENOENT') {
        const known =
          runtimeFor(exec.display || exec.cmd) || (step.requires || []).map(runtimeFor).find(Boolean) || null;
        const name = known ? known.label : exec.display || exec.cmd;
        const url = known ? known.url : installHint(exec.display || exec.cmd || '').url;
        const note = known ? known.note : installHint(exec.display || exec.cmd || '').note;
        step.error = [
          `This step needs ${name}, which is not installed on this machine.`,
          url ? `Download it from ${url}.` : '',
          note ? `Note: ${note}` : '',
          'After installing it, use "Re-check tools" and run this step again: GUITinstal reads the Windows PATH again at that moment.',
        ]
          .filter(Boolean)
          .join(' ');
      } else {
        step.error = `${error.code || 'ERROR'}: ${error.message}`;
      }
      step.endedAt = new Date().toISOString();
      run.status = 'failed';
      run.endedAt = new Date().toISOString();
      this.emit(run);
    });

    if (isBackground) {
      // A launcher (dev server, compose up) is meant to keep running. If it
      // dies right away, the log explains why instead of silently vanishing.
      step.pid = child.pid;
      step.logPath = logPath;

      let settled = false;
      const finishBackground = async (exitCode) => {
        if (settled) return;
        settled = true;
        step.exitCode = exitCode;
        step.endedAt = new Date().toISOString();

        if (exitCode === null) {
          step.status = 'done';
          step.url = logPath ? findLatestLocalUrl(readLogFrom(logPath, logStart)) : '';
          step.notes = step.url
            ? `Running at ${step.url}`
            : logPath
              ? `Running in the background. Log: ${logPath}`
              : 'Running in the background.';
          this.advance(run, step.index);
          if (!step.url) this.recheckAddress(run, step, logPath, logStart);
          return;
        }

        const tail = logPath ? readLogTail(logPath, 12) : '';
        if (exitCode === 0) {
          // npm exits with 0 as soon as its own child is up, and that child is
          // the server. The port says whether anything is really still running.
          const served = logPath ? findLatestLocalUrl(readLogFrom(logPath, logStart)) : '';
          const owner = served ? await listeningPid(new URL(served).port) : 0;
          step.status = 'done';
          if (owner) {
            step.pid = owner;
            step.url = served;
            step.notes = `Running at ${served} (process ${owner}).`;
          } else {
            step.notes = logPath ? `Finished normally. Log: ${logPath}` : 'Finished normally.';
          }
        } else {
          step.status = 'failed';
          step.error = `The project process exited with code ${exitCode}.${tail ? `\n${tail}` : ''}`;
        }
        run.status = step.status === 'failed' ? 'failed' : run.status;
        if (step.status === 'failed') {
          run.status = 'failed';
          run.endedAt = new Date().toISOString();
        }
        this.emit(run);
        if (step.status === 'failed') return;
        this.advance(run, step.index);
      };

      child.on('exit', (code) => finishBackground(code));
      child.on('error', (error) => {
        step.status = 'failed';
        step.error = error.message;
        step.endedAt = new Date().toISOString();
        run.status = 'failed';
        run.endedAt = new Date().toISOString();
        this.emit(run);
      });

      setTimeout(() => {
        if (!settled) finishBackground(null);
      }, 2000).unref();

      return;
    }

    child.on('close', (code, signal) => {
      flushTails();
      run.child = null;
      step.awaitingInput = false;
      // Cancelling already killed this process and gave it its own state.
      if (step.status === 'cancelled' || run.status === 'cancelled') return;

      step.exitCode = code;
      step.endedAt = new Date().toISOString();
      if (code === 0) {
        step.status = 'done';
        // A runtime GUITinstal installed one step ago is invisible to the next
        // step until the tool lookup and PATH caches are dropped.
        if (step.provides) forgetToolLookups();
        this.advance(run, step.index);
      } else {
        step.status = 'failed';
        // Keep the original spawn error, it explains far more than the code.
        if (!step.error) {
          const reason = failureReason(step);
          step.error = step.prompt
            ? `The command stopped and asked "${step.prompt}". It gave up without an answer (exit ${code}). Run it again and type the answer in the box, or run the same command in a terminal inside the project folder.`
            : signal
              ? `Stopped by signal ${signal}.`
              : `Exited with code ${code}${reason ? `: ${reason}` : '.'}`;
        }
        run.status = 'failed';
        run.endedAt = new Date().toISOString();
        this.emit(run);
      }
    });
  }
}

/**
 * The process that really holds the port.
 *
 * `npm start` spawns the server as a child and can exit before it, so the
 * wrapper pid recorded at spawn time may be dead while the app still answers
 * HTTP. Storing that pid made the card say "not running" under a working
 * server and made Stop aim at a process that was already gone.
 */
function listeningPid(port) {
  const number = Number(port);
  return new Promise((resolve) => {
    if (!number || number < 1 || number > 65535) {
      resolve(0);
      return;
    }
    if (process.platform !== 'win32') {
      // Every unix names the listener table differently (ss, lsof, fuser), so
      // outside Windows the caller keeps the pid it spawned.
      resolve(0);
      return;
    }
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 6000 }, (error, stdout) => {
      if (error) {
        resolve(0);
        return;
      }
      const row = String(stdout || '')
        .split(/\r?\n/)
        .find((line) => line.includes('LISTENING') && new RegExp(`:${number}\\s`).test(line));
      resolve(row ? Number(row.trim().split(/\s+/).pop()) || 0 : 0);
    });
  });
}

/** Kills a process and its children (Windows needs taskkill for the tree). */
function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true));
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    resolve(true);
  });
}

module.exports = {
  RunManager,
  findLatestLocalUrl,
  killProcessTree,
  listeningPid,
  logSize,
  readLogFrom,
  failureReason,
};
