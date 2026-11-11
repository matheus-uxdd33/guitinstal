'use strict';

/**
 * Real installation proof for the runtime adapters.
 *
 * The adapter check (`runtime-adapters-check.js`) only proves that a vendor
 * still publishes the artifact and its digest. This script proves the rest of
 * the promise: download, checksum, unpack, run, and then use the tool for the
 * job the plan will actually ask of it — a virtual environment, a compiled
 * binary, a Composer install, a local PHP server.
 *
 * Always point it at a throwaway data folder, so nothing here touches the real
 * GUITinstal data or the system PATH:
 *
 *   GUITINSTAL_USER_DATA=<temp> node tools/install-proof.js install go
 *   GUITINSTAL_USER_DATA=<temp> node tools/install-proof.js persist
 *   GUITINSTAL_USER_DATA=<temp> node tools/install-proof.js repair composer
 *
 * `persist` is the restart test: a fresh process must reuse every managed tool
 * without downloading anything again.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  TOOLBOX,
  existingTool,
  managedToolDir,
  prepareTool,
  readManifest,
  toolEnv,
} = require('../core/runtime-install');
const { effectivePath, forgetToolLookups } = require('../core/tools');
const { userDataDir } = require('../core/paths');

const dataDir = userDataDir();
const workRoot = path.join(dataDir, 'proof-work');

function line(text) {
  console.log(text);
}

/** Child process environment: managed binaries first, then their own homes. */
function childEnv(extra = {}) {
  return { ...process.env, ...toolEnv(), PATH: effectivePath(), ...extra };
}

function exec(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\u001b\[[0-9;]*m/g, '').trim() });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      out += `\n[timed out after ${Math.round((options.timeout || 300000) / 1000)}s]`;
      finish(-1);
    }, options.timeout || 300000);
    timer.unref?.();

    try {
      child = spawn(cmd, args, {
        cwd: options.cwd || workRoot,
        windowsHide: true,
        env: childEnv(options.env),
      });
    } catch (error) {
      out += `\n${error.message}`;
      finish(-1);
      return;
    }
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', (error) => {
      out += `\n${error.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code === null ? -1 : code));
  });
}

function write(relative, text) {
  const file = path.join(workRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function httpGet(url, timeout = 5000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on('error', (error) => resolve({ status: 0, body: error.message }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
  });
}

function recorder() {
  const checks = [];
  return {
    checks,
    record(name, ok, detail = '') {
      const text = String(detail || '').replace(/\s+/g, ' ').slice(0, 300);
      checks.push({ name, ok: !!ok, detail: text });
      line(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${text ? ` — ${text.slice(0, 150)}` : ''}`);
    },
  };
}

const tests = {
  async git({ record }) {
    const tool = existingTool('git');
    record('executable exists', !!tool && fs.existsSync(tool.bin), tool ? tool.bin : 'missing');
    if (!tool) return;

    const dir = managedToolDir('git');
    record(
      'the managed copy is the one resolved',
      path.resolve(tool.bin) === path.resolve(path.join(dir, 'cmd', 'git.exe')),
      tool.bin
    );

    const version = await exec(tool.bin, ['--version']);
    record('git --version', version.code === 0 && /git version 2\./i.test(version.out), version.out);

    const helper = path.join(dir, 'ucrt64', 'bin', 'git-remote-https.exe');
    record('HTTPS helper present', fs.existsSync(helper), helper);

    // The wrapper in cmd/ is what makes a stripped-down machine work: calling
    // ucrt64/bin/git.exe directly answers "unable to find remote helper".
    const clone = path.join(workRoot, 'git-clone');
    fs.rmSync(clone, { recursive: true, force: true });
    const cloned = await exec(
      tool.bin,
      ['clone', '--depth', '1', 'https://github.com/sindresorhus/is.git', clone],
      { timeout: 180000 }
    );
    record('clone over HTTPS', cloned.code === 0 && fs.existsSync(path.join(clone, 'package.json')), cloned.code === 0 ? clone : cloned.out.slice(-300));
    if (cloned.code !== 0) return;

    const head = await exec(tool.bin, ['rev-parse', '--short', 'HEAD'], { cwd: clone });
    record('commit read back', head.code === 0 && /^[0-9a-f]{7,}$/.test(head.out), head.out);
  },

  async python({ record }) {
    const tool = existingTool('python');
    record('executable exists', !!tool && fs.existsSync(tool.bin), tool ? tool.bin : 'missing');
    if (!tool) return;

    const version = await exec(tool.bin, ['--version']);
    record('python --version', version.code === 0 && /Python 3\./.test(version.out), version.out);

    const home = managedToolDir('python');
    const layout = ['Lib', 'DLLs', 'Scripts'].every((name) => fs.existsSync(path.join(home, name)));
    record('portable layout kept', layout, home);

    const pip = await exec(tool.bin, ['-m', 'pip', '--version']);
    record('pip answers', pip.code === 0, pip.out.split('\n')[0]);

    const venv = path.join(workRoot, 'python-venv');
    fs.rmSync(venv, { recursive: true, force: true });
    const made = await exec(tool.bin, ['-m', 'venv', venv], { timeout: 180000 });
    const venvPython = path.join(venv, 'Scripts', 'python.exe');
    record('venv created', made.code === 0 && fs.existsSync(venvPython), made.code === 0 ? venvPython : made.out);

    if (!fs.existsSync(venvPython)) return;
    const installed = await exec(
      venvPython,
      ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--cache-dir', path.join(workRoot, 'pip-cache'), 'six==1.17.0'],
      { timeout: 240000 }
    );
    record('pip install into venv', installed.code === 0, installed.code === 0 ? 'six==1.17.0' : installed.out.slice(-300));

    write('python-app/test_installation.py', 'import six, sys\nprint(f"six {six.__version__} on {sys.version.split()[0]}")\n');
    const run = await exec(venvPython, [path.join(workRoot, 'python-app', 'test_installation.py')]);
    record('script executes', run.code === 0 && /six 1\.17\.0/.test(run.out), run.out);
  },

  async go({ record }) {
    const tool = existingTool('go');
    record('executable exists', !!tool && fs.existsSync(tool.bin), tool ? tool.bin : 'missing');
    if (!tool) return;

    const version = await exec(tool.bin, ['version']);
    record('go version', version.code === 0 && /go1\./.test(version.out), version.out);

    const dir = path.join(workRoot, 'go-app');
    fs.rmSync(dir, { recursive: true, force: true });
    write('go-app/go.mod', 'module proof\n\ngo 1.21\n');
    write('go-app/main.go', 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("go proof ok") }\n');

    const env = { GOTOOLCHAIN: 'local' };
    const tidy = await exec(tool.bin, ['mod', 'tidy'], { cwd: dir, env, timeout: 180000 });
    record('go mod tidy', tidy.code === 0, tidy.out || 'no modules required');

    const build = await exec(tool.bin, ['build', '-o', 'proof.exe', '.'], { cwd: dir, env, timeout: 240000 });
    const exe = path.join(dir, 'proof.exe');
    record('go build', build.code === 0 && fs.existsSync(exe), build.code === 0 ? 'proof.exe' : build.out.slice(-400));
    if (!fs.existsSync(exe)) return;

    const run = await exec(exe, [], { cwd: dir });
    record('compiled program runs', run.code === 0 && /go proof ok/.test(run.out), run.out);
  },

  async java({ record }) {
    const home = managedToolDir('java');
    const java = path.join(home, 'bin', 'java.exe');
    const javac = path.join(home, 'bin', 'javac.exe');
    const keepsJdk = fs.existsSync(path.join(home, 'lib')) && fs.existsSync(path.join(home, 'conf'));
    record('JDK layout survives unpacking', fs.existsSync(java) && fs.existsSync(javac) && keepsJdk, home);
    if (!fs.existsSync(java)) return;

    const version = await exec(java, ['-version']);
    record('java -version', version.code === 0 && /version/i.test(version.out), version.out.split('\n')[0]);

    const compiler = await exec(javac, ['-version']);
    record('javac -version', compiler.code === 0, compiler.out);

    const dir = path.join(workRoot, 'java-app');
    fs.rmSync(dir, { recursive: true, force: true });
    write(
      'java-app/Hello.java',
      'public class Hello {\n  public static void main(String[] args) {\n    System.out.println("java proof ok " + System.getProperty("java.version"));\n  }\n}\n'
    );

    const compiled = await exec(javac, ['Hello.java'], { cwd: dir, env: { JAVA_HOME: home }, timeout: 180000 });
    record('javac compiles', compiled.code === 0 && fs.existsSync(path.join(dir, 'Hello.class')), compiled.out || 'Hello.class');

    const run = await exec(java, ['-cp', dir, 'Hello'], { env: { JAVA_HOME: home } });
    record('compiled class runs', run.code === 0 && /java proof ok/.test(run.out), run.out);
  },

  async uv({ record }) {
    const tool = existingTool('uv');
    record('executable exists', !!tool && fs.existsSync(tool.bin), tool ? tool.bin : 'missing');
    if (!tool) return;

    const version = await exec(tool.bin, ['--version']);
    record('uv --version', version.code === 0, version.out);

    const dir = path.join(workRoot, 'uv-app');
    fs.rmSync(dir, { recursive: true, force: true });
    write(
      'uv-app/pyproject.toml',
      '[project]\nname = "proof"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = ["six==1.17.0"]\n'
    );
    write('uv-app/main.py', 'import six\nprint("uv proof ok", six.__version__)\n');

    const managedPython = path.join(managedToolDir('python'), 'python.exe');
    const pythonVersion = (await exec(managedPython, ['--version'])).out.replace(/^Python\s+/, '').trim();
    const env = {
      UV_CACHE_DIR: path.join(workRoot, 'uv-cache'),
      // Naming the interpreter and refusing downloads is what proves uv used the
      // Python this app installed instead of fetching another one.
      UV_PYTHON: managedPython,
      UV_PYTHON_DOWNLOADS: 'never',
      UV_NO_PROGRESS: '1',
    };
    const sync = await exec(tool.bin, ['sync'], { cwd: dir, env, timeout: 300000 });
    record(
      'uv sync with managed Python',
      sync.code === 0 && fs.existsSync(path.join(dir, '.venv')),
      sync.code === 0 ? '.venv created' : sync.out.slice(-400)
    );

    const used = await exec(tool.bin, ['run', 'python', '-c', 'import sys; print(sys.version.split()[0])'], { cwd: dir, env });
    record('environment uses managed Python ' + pythonVersion, used.code === 0 && used.out.trim() === pythonVersion, used.out);

    const run = await exec(tool.bin, ['run', 'python', 'main.py'], { cwd: dir, env, timeout: 180000 });
    record('uv run executes the project', run.code === 0 && /uv proof ok/.test(run.out), run.out);
  },

  async bun({ record }) {
    const tool = existingTool('bun');
    record('executable exists', !!tool && fs.existsSync(tool.bin), tool ? tool.bin : 'missing');
    if (!tool) return;

    const version = await exec(tool.bin, ['--version']);
    record('bun --version', version.code === 0, version.out);

    const dir = path.join(workRoot, 'bun-app');
    fs.rmSync(dir, { recursive: true, force: true });
    write(
      'bun-app/package.json',
      JSON.stringify({ name: 'proof', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } }, null, 2)
    );
    write(
      'bun-app/main.js',
      "const isNumber = require('is-number');\nconsole.log('bun proof ok', isNumber(42), isNumber('x'));\n"
    );

    const env = { BUN_INSTALL_CACHE_DIR: path.join(workRoot, 'bun-cache') };
    const installed = await exec(tool.bin, ['install'], { cwd: dir, env, timeout: 240000 });
    record(
      'bun install',
      installed.code === 0 && fs.existsSync(path.join(dir, 'node_modules', 'is-number')),
      installed.code === 0 ? 'node_modules/is-number' : installed.out.slice(-300)
    );

    const run = await exec(tool.bin, ['run', 'main.js'], { cwd: dir, env });
    record('script executes', run.code === 0 && /bun proof ok true false/.test(run.out), run.out);
  },

  async php({ record }) {
    const php = path.join(managedToolDir('php'), 'php.exe');
    record('executable exists', fs.existsSync(php), php);
    if (!fs.existsSync(php)) return;

    const version = await exec(php, ['-v']);
    record('php -v', version.code === 0 && /PHP 8\./.test(version.out), version.out.split('\n')[0]);

    const modules = await exec(php, ['-m']);
    const listed = new Set(
      modules.out
        .split(/\r?\n/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    );
    const required = ['curl', 'fileinfo', 'mbstring', 'openssl', 'pdo_sqlite', 'sqlite3', 'zip'];
    const missing = required.filter((name) => !listed.has(name));
    record('required extensions loaded', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : required.join(', '));

    const dir = path.join(workRoot, 'php-app');
    write('php-app/index.php', '<?php header("Content-Type: text/plain"); echo "php proof ok " . PHP_VERSION;\n');

    const port = 8787;
    const server = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', dir], {
      cwd: dir,
      windowsHide: true,
      env: childEnv(),
    });
    let answer = { status: 0, body: 'not reached' };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      answer = await httpGet(`http://127.0.0.1:${port}/`);
      if (answer.status === 200) break;
    }
    try {
      server.kill();
    } catch {
      /* already gone */
    }
    record('built-in server answers HTTP', answer.status === 200 && /php proof ok/.test(answer.body), `${answer.status} ${answer.body}`);
  },

  async composer({ record }) {
    const dir = managedToolDir('composer');
    const phar = path.join(dir, 'composer.phar');
    const php = path.join(managedToolDir('php'), 'php.exe');
    record('composer.phar next to managed PHP', fs.existsSync(phar) && fs.existsSync(php), dir);
    if (!fs.existsSync(phar) || !fs.existsSync(php)) return;

    const version = await exec(php, [phar, '--version', '--no-ansi'], { timeout: 180000 });
    record('composer --version', version.code === 0 && /Composer version/.test(version.out), version.out.split('\n')[0]);

    const app = path.join(workRoot, 'composer-app');
    fs.rmSync(app, { recursive: true, force: true });
    write('composer-app/composer.json', JSON.stringify({ name: 'proof/app', require: { 'psr/log': '3.0.2' } }, null, 2));
    write(
      'composer-app/test.php',
      "<?php\nrequire __DIR__ . '/vendor/autoload.php';\necho interface_exists('Psr\\\\Log\\\\LoggerInterface') ? 'composer proof ok' : 'missing interface';\n"
    );

    const env = {
      COMPOSER_HOME: path.join(workRoot, 'composer-home'),
      COMPOSER_CACHE_DIR: path.join(workRoot, 'composer-cache'),
      COMPOSER_NO_INTERACTION: '1',
    };
    const installed = await exec(php, [phar, 'install', '--no-interaction', '--no-progress'], { cwd: app, env, timeout: 300000 });
    const autoload = path.join(app, 'vendor', 'autoload.php');
    record(
      'composer install',
      installed.code === 0 && fs.existsSync(autoload),
      installed.code === 0 ? 'vendor/autoload.php' : installed.out.slice(-400)
    );

    const run = await exec(php, [path.join(app, 'test.php')], { cwd: app });
    record('autoload resolves the package', run.code === 0 && /composer proof ok/.test(run.out), run.out);
  },

  async rustup({ record }) {
    const home = managedToolDir('rustup');
    const cargo = path.join(home, 'bin', 'cargo.exe');
    const rustc = path.join(home, 'bin', 'rustc.exe');
    record('toolchain inside the managed folder', fs.existsSync(cargo) && fs.existsSync(rustc), home);
    if (!fs.existsSync(cargo) || !fs.existsSync(rustc)) return;
    record('managed folder is not ~/.cargo', path.resolve(home) !== path.resolve(path.join(process.env.USERPROFILE || '', '.cargo', 'bin')), home);

    const rustcVersion = await exec(rustc, ['--version']);
    record('rustc --version', rustcVersion.code === 0 && /^rustc 1\./.test(rustcVersion.out), rustcVersion.out);

    const cargoVersion = await exec(cargo, ['--version']);
    record('cargo --version', cargoVersion.code === 0, cargoVersion.out);

    const app = path.join(workRoot, 'rust-app');
    fs.rmSync(app, { recursive: true, force: true });
    const created = await exec(cargo, ['new', '--quiet', '--bin', 'rust-app'], { cwd: workRoot, timeout: 180000 });
    const entry = path.join(app, 'src', 'main.rs');
    record('cargo new', created.code === 0 && fs.existsSync(entry), created.code === 0 ? entry : created.out);
    if (!fs.existsSync(entry)) return;

    write('rust-app/src/main.rs', 'fn main() {\n    println!("rust proof ok {}", env!("CARGO_PKG_VERSION"));\n}\n');
    const built = await exec(cargo, ['build', '--quiet'], { cwd: app, timeout: 600000 });
    const exe = path.join(app, 'target', 'debug', 'rust-app.exe');
    record('cargo build', built.code === 0 && fs.existsSync(exe), built.code === 0 ? 'target/debug/rust-app.exe' : built.out.slice(-400));
    if (!fs.existsSync(exe)) return;

    const run = await exec(exe, [], { cwd: app });
    record('compiled binary runs', run.code === 0 && /rust proof ok/.test(run.out), run.out);
  },
};

/** Installs one adapter and keeps every line the install printed. */
async function installAdapter(id) {
  line(`\n=== ${id} ===`);
  const started = Date.now();
  const log = [];
  let result = null;
  let error = '';
  try {
    result = await prepareTool(id, {
      onLine: (text) => {
        log.push(text);
        line(`  | ${text}`);
      },
    });
  } catch (failure) {
    error = failure.message;
    line(`  ! ${error}`);
  }
  forgetToolLookups();

  const manifest = readManifest()[id] || null;
  const source = (log.find((text) => text.startsWith('source ')) || '').replace(/^source /, '');
  const checksum = ((log.find((text) => text.startsWith('checksum verified')) || '').match(/\(([0-9a-f]+)/) || [])[1] || '';
  const download = [...log].reverse().find((text) => text.startsWith('downloaded ')) || '';

  return {
    id,
    installed: !error && !!result,
    reused: !!result?.reused,
    version: result?.version || '',
    dir: result?.dir || '',
    seconds: Math.round((Date.now() - started) / 1000),
    source,
    checksum,
    download,
    sha256: manifest?.sha256 || '',
    error,
    log,
  };
}

async function installMode(id) {
  if (!tests[id]) {
    console.error(`unknown adapter "${id}". Known: ${Object.keys(tests).join(', ')}`);
    process.exit(2);
  }
  line(`data folder: ${dataDir}`);
  const install = await installAdapter(id);
  const { checks, record } = recorder();

  if (!install.installed) {
    line(`\nPROOF ${JSON.stringify({ id, verdict: 'FAILED', install, checks })}`);
    process.exitCode = 1;
    return;
  }

  line('  functional test');
  await tests[id]({ record });

  const verdict = install.installed && checks.every((check) => check.ok) ? 'VERIFIED' : 'FAILED';
  line(`\nPROOF ${JSON.stringify({ id, verdict, install, checks })}`);
  if (verdict !== 'VERIFIED') process.exitCode = 1;
}

/** Restart test: a new process must reuse everything, downloading nothing. */
async function persistMode() {
  line(`data folder: ${dataDir}`);
  const rows = [];
  for (const id of Object.keys(TOOLBOX)) {
    if (!existingTool(id)) {
      line(`${id}: not installed`);
      rows.push({ id, present: false });
      continue;
    }
    const log = [];
    let result = null;
    let error = '';
    const started = Date.now();
    try {
      result = await prepareTool(id, { onLine: (text) => log.push(text) });
    } catch (failure) {
      error = failure.message;
    }
    forgetToolLookups();
    const downloaded = log.some((text) => text.startsWith('downloaded '));
    const row = {
      id,
      present: true,
      version: result?.version || '',
      reused: !!result?.reused,
      downloaded,
      seconds: Math.round((Date.now() - started) / 1000),
      dir: result?.dir || '',
      error,
    };
    rows.push(row);
    line(
      `${id}: ${error ? `FAILED ${error}` : `${row.reused ? 'reused' : 'REINSTALLED'} ${row.version}${downloaded ? ' (downloaded again)' : ''}`}`
    );
  }
  const tempLeft = fs.existsSync(path.join(dataDir, 'tools', '.tmp'))
    ? fs.readdirSync(path.join(dataDir, 'tools', '.tmp'))
    : [];
  line(`leftover downloads: ${tempLeft.length}`);
  line(`\nPERSIST ${JSON.stringify({ rows, leftovers: tempLeft })}`);

  const broken = rows.some((row) => row.present && (row.error || !row.reused || row.downloaded));
  if (broken || tempLeft.length) process.exitCode = 1;
}

/** Damage one managed tool and prove prepareTool repairs it. */
async function repairMode(id) {
  line(`data folder: ${dataDir}`);
  const tool = existingTool(id);
  if (!tool) {
    console.error(`${id} is not installed in ${dataDir}`);
    process.exit(2);
  }
  const backup = `${tool.bin}.broken`;
  fs.renameSync(tool.bin, backup);
  line(`broken on purpose: ${tool.bin} -> ${path.basename(backup)}`);

  const log = [];
  let result = null;
  let error = '';
  try {
    result = await prepareTool(id, {
      onLine: (text) => {
        log.push(text);
        line(`  | ${text}`);
      },
    });
  } catch (failure) {
    error = failure.message;
  }
  forgetToolLookups();

  const healed = !!result && fs.existsSync(tool.bin);
  if (healed) fs.rmSync(backup, { force: true });
  line(`\nREPAIR ${JSON.stringify({ id, healed, version: result?.version || '', error, downloaded: log.some((text) => text.startsWith('downloaded ')) })}`);
  if (!healed) process.exitCode = 1;
}

const mode = String(process.argv[2] || 'install').toLowerCase();
const target = String(process.argv[3] || '').trim();

fs.mkdirSync(workRoot, { recursive: true });

if (mode === 'persist') {
  persistMode();
} else if (mode === 'repair') {
  repairMode(target);
} else {
  installMode(target);
}
