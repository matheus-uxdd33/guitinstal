'use strict';

/**
 * The universal installation workflow.
 *
 * Sixteen steps, always in the same order, from a pasted link to a tool that
 * starts. Each step names the file that owns it, so the workflow is a map of
 * the application rather than a wish list.
 *
 * The status of every step is measured, not declared: "implemented" means the
 * code is there and runs, "partial" means it works for some stacks and not for
 * others, and "planned" means the module exists as configuration but nothing
 * calls it yet. That distinction is the whole point of keeping the workflow
 * next to the code.
 */

const STEPS = [
  {
    order: 1,
    key: 'validate',
    title: 'Validate',
    purpose: 'Check that the link points at a repository GUITinstal can read.',
    owner: 'core/repo-url.js, server/api.js',
    approval: false,
    produces: 'a normalized owner/repo pair and a reachable repository',
    planSteps: [],
    status: 'implemented',
    note: 'A malformed or private URL is refused before anything is downloaded.',
  },
  {
    order: 2,
    key: 'scan',
    title: 'Scan',
    purpose: 'Read the repository tree and the manifests that describe it.',
    owner: 'core/github.js, core/detect.js',
    approval: false,
    produces: 'the file tree and the content of the root manifests',
    planSteps: [],
    status: 'partial',
    note: 'The tree and the root manifests are read. The README is not parsed yet, so a repository that only explains itself in the README is still under-detected.',
  },
  {
    order: 3,
    key: 'detect',
    title: 'Detect',
    purpose: 'Work out the language, framework, package manager and entry point.',
    owner: 'core/detect.js, core/engine/project-type.js',
    approval: false,
    produces: 'the stack and the project category',
    planSteps: [],
    status: 'implemented',
    note: 'Ten stack families are recognized, and the project category decides which launch options may be offered.',
  },
  {
    order: 4,
    key: 'compatibility',
    title: 'Compatibility',
    purpose: 'Check whether this project can run on this operating system and processor.',
    owner: 'core/engine/compatibility.js, core/plan.js',
    approval: false,
    produces: 'a verdict per runtime: installable, guided, partial or blocked',
    planSteps: [],
    status: 'implemented',
    note: 'The plan builder calls the compatibility engine with the adapters that exist in this build. Only an installable runtime becomes a setup step; a guided one becomes its official page; a blocked project cannot start a run at all.',
  },
  {
    order: 5,
    key: 'runtime-preparation',
    title: 'Runtime preparation',
    purpose: 'Install the tools the project needs and that this machine does not have.',
    owner: 'core/runtime-install.js',
    approval: true,
    produces: 'a verified runtime under <userData>/tools',
    planSteps: ['prepare-node', 'prepare-python', 'prepare-go', 'prepare-java', 'prepare-uv', 'prepare-bun', 'prepare-php', 'prepare-composer', 'prepare-rustup'],
    status: 'implemented',
    note: 'Nine adapters install software on Windows: Node.js, Python, Go, Java (Temurin JDK), uv, Bun, PHP, Composer and rustup. Each one resolves the current release from the vendor index at install time, verifies the published digest, and proves the tool runs before the step is called done. Runtimes without an adapter stay guided installs with their official page attached.',
  },
  {
    order: 6,
    key: 'installation-plan',
    title: 'Installation plan',
    purpose: 'Write the ordered list of commands that will install this project.',
    owner: 'core/plan.js',
    approval: false,
    produces: 'a plan with one step per command, its risk and its purpose',
    planSteps: [],
    status: 'implemented',
    note: 'A missing runtime becomes a step of the plan instead of a dead end.',
  },
  {
    order: 7,
    key: 'user-approval',
    title: 'User approval',
    purpose: 'Show the exact command, the download and the risk, and wait for a yes.',
    owner: 'core/runner.js',
    approval: true,
    produces: 'an approved step',
    planSteps: [],
    status: 'implemented',
    note: 'Nothing runs before the person presses Approve. A failed step can be retried on its own.',
  },
  {
    order: 8,
    key: 'download',
    title: 'Download',
    purpose: 'Clone the repository into the workspace.',
    owner: 'core/git.js, core/plan.js',
    approval: true,
    produces: 'the project folder',
    planSteps: ['clone'],
    status: 'implemented',
    note: 'A folder that already holds something else is never overwritten.',
  },
  {
    order: 9,
    key: 'environment',
    title: 'Environment',
    purpose: 'Give the project an isolated environment of its own.',
    owner: 'core/plan.js',
    approval: true,
    produces: 'a virtual environment inside the project folder',
    planSteps: ['venv'],
    status: 'partial',
    note: 'Python projects get a .venv, or a uv-managed .venv when the project ships uv.lock. Node projects install into their own node_modules. Java, .NET, Ruby and Go still resolve dependencies on the machine tool cache.',
  },
  {
    order: 10,
    key: 'dependencies',
    title: 'Dependencies',
    purpose: 'Install what the manifest declares, with the package manager the project uses.',
    owner: 'core/plan.js',
    approval: true,
    produces: 'the dependency tree',
    planSteps: ['install'],
    status: 'implemented',
    note: 'npm, pip, composer, bundler, cargo, go mod, nuget and maven each have their own step.',
  },
  {
    order: 11,
    key: 'configuration',
    title: 'Configuration',
    purpose: 'Walk the person through the settings the project needs.',
    owner: 'core/secret-store.js, core/plan.js',
    approval: true,
    produces: 'an .env file and the stored secrets',
    planSteps: ['configure', 'configure-key', 'migrate'],
    status: 'partial',
    note: 'The .env guidance and the local secret store exist. GUITinstal never invents an API key and never sends a secret anywhere.',
  },
  {
    order: 12,
    key: 'build',
    title: 'Build',
    purpose: 'Compile the project when its build configuration supports it.',
    owner: 'core/plan.js',
    approval: true,
    produces: 'the build output',
    planSteps: ['build'],
    status: 'implemented',
    note: 'A project with no build step simply has none.',
  },
  {
    order: 13,
    key: 'verification',
    title: 'Verification',
    purpose: 'Check that the installation really produced files.',
    owner: 'core/verify.js',
    approval: false,
    produces: 'a verified folder with a file count and a Git revision',
    planSteps: [],
    status: 'implemented',
    note: 'A clone that downloaded nothing is not called an installation.',
  },
  {
    order: 14,
    key: 'register',
    title: 'Register',
    purpose: 'Save the project in the local library.',
    owner: 'core/store.js',
    approval: false,
    produces: 'a project record that survives a restart',
    planSteps: [],
    status: 'implemented',
    note: 'The library is a local SQLite file. The source code stays on disk and is never copied into the database.',
  },
  {
    order: 15,
    key: 'launch',
    title: 'Launch',
    purpose: 'Build the launch configuration and start the project.',
    owner: 'server/api.js, core/plan.js',
    approval: true,
    produces: 'a running process and a known local URL',
    planSteps: ['launch'],
    status: 'implemented',
    note: 'A Run button only appears when there is a real launch configuration behind it.',
  },
  {
    order: 16,
    key: 'complete',
    title: 'Complete',
    purpose: 'Show what happened and what can be done next.',
    owner: 'ui/app.js',
    approval: false,
    produces: 'the next available action',
    planSteps: [],
    status: 'implemented',
    note: 'The result is the actual outcome, not a promise about it.',
  },
];

/**
 * The sixteen engine modules, each one mapped to the file that owns it.
 *
 * @type {Array<{id: string, label: string, owner: string, status: string, note: string}>}
 */
const MODULES = [
  {
    id: 'repository-manager',
    label: 'Repository Manager',
    owner: 'core/git.js, core/github.js',
    status: 'implemented',
    note: 'Clones repositories and reads their metadata over the GitHub API.',
  },
  {
    id: 'repository-scanner',
    label: 'Repository Scanner',
    owner: 'core/detect.js',
    status: 'implemented',
    note: 'Reads the tree and the manifests, and recognizes ten stack families.',
  },
  {
    id: 'compatibility-engine',
    label: 'Compatibility Engine',
    owner: 'core/engine/compatibility.js, core/plan.js',
    status: 'implemented',
    note: 'Answers per runtime and per platform, and the plan builder uses that answer to decide which steps exist.',
  },
  {
    id: 'runtime-manager',
    label: 'Runtime Manager',
    owner: 'core/runtime-install.js',
    status: 'implemented',
    note: 'Downloads, verifies and installs nine runtimes from official sources, each checked against the digest the vendor publishes.',
  },
  {
    id: 'dependency-manager',
    label: 'Dependency Manager',
    owner: 'core/plan.js',
    status: 'implemented',
    note: 'One step per package manager, each using the lockfile the project ships.',
  },
  {
    id: 'environment-builder',
    label: 'Environment Builder',
    owner: 'core/plan.js',
    status: 'partial',
    note: 'Builds a virtual environment for Python projects.',
  },
  {
    id: 'application-builder',
    label: 'Application Builder',
    owner: 'core/plan.js, core/engine/project-type.js',
    status: 'implemented',
    note: 'Builds the launch profile that matches the project category.',
  },
  {
    id: 'installation-engine',
    label: 'Installation Engine',
    owner: 'core/plan.js, core/runner.js',
    status: 'implemented',
    note: 'Turns a repository into an ordered, reviewable plan.',
  },
  {
    id: 'installation-verifier',
    label: 'Installation Verifier',
    owner: 'core/verify.js',
    status: 'implemented',
    note: 'Surveys the folder and checks the project kind: files, Git revision, manifest, the dependency folder of that stack, a missing .env and the launch profile, then reports installed, verified or launchable.',
  },
  {
    id: 'process-manager',
    label: 'Process Manager',
    owner: 'core/runner.js',
    status: 'implemented',
    note: 'Tracks process ids, streams logs, cancels a run and stops a process tree.',
  },
  {
    id: 'launch-manager',
    label: 'Launch Manager',
    owner: 'server/api.js',
    status: 'implemented',
    note: 'Starts a project, watches for its local URL and opens it in the browser.',
  },
  {
    id: 'update-manager',
    label: 'Update Manager',
    owner: 'core/git.js',
    status: 'partial',
    note: 'Compares the local revision with the remote one. A safe update that preserves local changes is not finished.',
  },
  {
    id: 'project-library',
    label: 'Project Library',
    owner: 'core/store.js',
    status: 'implemented',
    note: 'A local SQLite library that survives a restart.',
  },
  {
    id: 'terminal-manager',
    label: 'Terminal Manager',
    owner: 'core/runner.js',
    status: 'partial',
    note: 'A real log stream with the command and the output. It is not an interactive terminal.',
  },
  {
    id: 'security-manager',
    label: 'Security Manager',
    owner: 'core/secret-store.js, core/runner.js, server/main.js',
    status: 'implemented',
    note: 'Approval per command, no elevation, secrets kept locally and a token on every request.',
  },
  {
    id: 'ai-installation-assistant',
    label: 'AI Installation Assistant',
    owner: 'core/assistant.js',
    status: 'partial',
    note: 'Explains a repository and the errors. It cannot run a command and cannot invent a successful installation.',
  },
];

/** Which plan step belongs to which workflow step. */
const PLAN_STEP_PHASE = {
  clone: 'download',
  venv: 'environment',
  install: 'dependencies',
  configure: 'configuration',
  'configure-key': 'configuration',
  migrate: 'configuration',
  build: 'build',
  launch: 'launch',
};

function steps() {
  return STEPS;
}

function step(key) {
  return STEPS.find((item) => item.key === key) || null;
}

function modules() {
  return MODULES;
}

/**
 * Places a plan on the workflow: which steps this plan already covers.
 *
 * @param {{steps?: Array<{id: string}>}} plan
 */
function forPlan(plan) {
  const ids = (plan?.steps || []).map((item) => item.id);
  const covered = new Set();

  for (const id of ids) {
    if (String(id).startsWith('prepare-')) {
      covered.add('runtime-preparation');
      continue;
    }
    const phase = PLAN_STEP_PHASE[id];
    if (phase) covered.add(phase);
  }
  if (ids.includes('clone')) covered.add('download');
  if (ids.length) {
    covered.add('installation-plan');
    covered.add('user-approval');
  }

  return {
    steps: STEPS.map((item) => ({
      ...item,
      covered: covered.has(item.key),
    })),
    covered: [...covered],
  };
}

/** The steps that still need code, in order. */
function gaps() {
  return STEPS.filter((item) => item.status !== 'implemented').map((item) => ({
    order: item.order,
    key: item.key,
    title: item.title,
    status: item.status,
    note: item.note,
  }));
}

module.exports = { MODULES, PLAN_STEP_PHASE, STEPS, forPlan, gaps, modules, step, steps };
