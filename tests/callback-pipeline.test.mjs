import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveAgentApiExe, resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  invokeAgentApiSend,
  loadRegistry,
  saveRegistry,
  syncCompletionToCoordinator,
  syncThreads,
} from '../lib/store.mjs';

function createTempAntigravityEnv(t, prefix = 'pt-cb-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_AGENTAPI_EXE',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;
  delete process.env.ANTIGRAVITY_AGENTAPI_EXE;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function writeMockAgentApiScript(dir, name, jsBody) {
  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, jsBody, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = join(dir, name);
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, 'utf8');
  chmodSync(shPath, 0o755);
  return shPath;
}

test('invokeAgentApiSend waits for actual completion and propagates non-zero exits, JSON errors, and spawn errors', async (t) => {
  const { tempRoot } = createTempAntigravityEnv(t, 'pt-send-');
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';

  // 1. Slow failure (>750ms, exceeding old 650ms fastTimer) must reject rather than resolving early
  const slowFailExe = writeMockAgentApiScript(
    tempRoot,
    'slow-fail',
    `setTimeout(() => { process.stderr.write('delivery failed after delay\\n'); process.exit(2); }, 780);`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = slowFailExe;

  const t0 = Date.now();
  await assert.rejects(
    () =>
      invokeAgentApiSend({
        conversationId: 'coord-conv-0001',
        message: 'hello',
        title: 'Test',
        projectId: '',
        timeoutMs: 5000,
      }),
    /delivery failed after delay/,
  );
  assert.ok(Date.now() - t0 >= 700, 'should wait for actual exit instead of settling on a short timer');

  // 2. Slow success (>750ms) waits for completion and returns stdout without early background resolution
  const slowOkExe = writeMockAgentApiScript(
    tempRoot,
    'slow-ok',
    `setTimeout(() => { process.stdout.write(JSON.stringify({ response: { sendMessage: { ok: true } }, args: process.argv.slice(2) })); }, 780);`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = slowOkExe;

  const t1 = Date.now();
  const res = await invokeAgentApiSend({
    conversationId: 'coord-conv-0001',
    message: 'hello',
    title: 'Test',
    projectId: '',
    timeoutMs: 5000,
  });
  assert.ok(Date.now() - t1 >= 700);
  assert.equal(res.queued, true);
  assert.equal(res.background, undefined);
  assert.match(res.output, /"sendMessage"/);

  // 3. JSON payload containing "error" must reject even if process exited 0
  const jsonErrExe = writeMockAgentApiScript(
    tempRoot,
    'json-err',
    `process.stdout.write(JSON.stringify({ response: {}, error: 'rpc error: unavailable' }));`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = jsonErrExe;
  await assert.rejects(
    () =>
      invokeAgentApiSend({
        conversationId: 'coord-conv-0001',
        message: 'hello',
        projectId: '',
        timeoutMs: 5000,
      }),
    /rpc error: unavailable/,
  );

  // 4. Direct agentapi shim filename passes ["send-message", ...] without duplicating "agentapi"
  const directApiExe = writeMockAgentApiScript(
    tempRoot,
    'agentapi',
    `process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = directApiExe;
  const directRes = await invokeAgentApiSend({
    conversationId: 'coord-conv-0001',
    message: 'ping',
    title: 'Check',
    projectId: '',
    timeoutMs: 5000,
  });
  const parsedArgs = JSON.parse(directRes.output).args;
  assert.equal(parsedArgs[0], 'send-message');
  assert.notEqual(parsedArgs[1], 'send-message');

  // 5. Invalid/corrupt executable causes spawn error instead of resolving
  const badExePath = join(tempRoot, process.platform === 'win32' ? 'broken.exe' : 'broken-bin');
  writeFileSync(badExePath, 'not-a-valid-binary', 'utf8');
  if (process.platform !== 'win32') chmodSync(badExePath, 0o755);
  process.env.ANTIGRAVITY_AGENTAPI_EXE = badExePath;
  await assert.rejects(() =>
    invokeAgentApiSend({
      conversationId: 'coord-conv-0001',
      message: 'hello',
      projectId: '',
      timeoutMs: 5000,
    }),
  );
});

test('syncCompletionToCoordinator leaves retry state clean on failure and persists + deduplicates once delivery succeeds', async (t) => {
  const { tempRoot, appDataDir, stateDir } = createTempAntigravityEnv(t, 'pt-sync-');
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59998';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';

  const workerConvId = 'conv-worker-00000010';
  const coordConvId = 'conv-coord-00000001';
  const txDir = join(appDataDir, 'brain', workerConvId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  writeFileSync(
    join(txDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Fix bug</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        content: '### Thread Summary\nFixed the bug cleanly.',
      }),
    ].join('\n'),
    'utf8',
  );

  const reg = loadRegistry();
  reg.coordinators['__test__'] = {
    key: '__test__',
    conversationId: coordConvId,
    workspacePath: '',
    title: '[Coordinator] Test',
  };
  reg.threads['thr-010'] = {
    threadId: 'thr-010',
    conversationId: workerConvId,
    coordinatorId: coordConvId,
    workspaceKey: '__test__',
    title: 'Fix callback bug',
    model: 'pro',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    lastSummary: '',
    lastCompletedAt: '',
    notifiedCoordinatorAt: '',
    createdAt: '2026-11-27T01:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
  };
  saveRegistry(reg);

  // Step 1: Failed delivery must NOT persist sync markers or leave claim locks behind
  const failingExe = writeMockAgentApiScript(
    tempRoot,
    'fail-api',
    `process.stderr.write('ls unreachable\\n'); process.exit(1);`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = failingExe;

  await assert.rejects(
    () => syncCompletionToCoordinator({ threadId: 'thr-010', force: false, timeoutMs: 5000 }),
    /ls unreachable/,
  );

  const regAfterFail = loadRegistry();
  const tAfterFail = regAfterFail.threads['thr-010'];
  assert.equal(tAfterFail.lastSyncedStepIndex, undefined);
  assert.equal(tAfterFail.pushedToCoordinatorAt || '', '');
  assert.equal(tAfterFail.notifiedCoordinatorAt || '', '');

  const claimsDir = join(stateDir, 'sync-claims');
  const remainingClaims = existsSync(claimsDir) ? readdirSync(claimsDir) : [];
  assert.deepEqual(remainingClaims, [], 'failed sync must release all claim files');

  // Step 2: Active concurrent claim returns already_claimed without poisoning sync markers
  mkdirSync(claimsDir, { recursive: true });
  const activeClaim = join(claimsDir, 'thr-010-step-5.claim');
  writeFileSync(activeClaim, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  const claimedRes = await syncCompletionToCoordinator({ threadId: 'thr-010', force: false });
  assert.equal(claimedRes.synced, false);
  assert.equal(claimedRes.reason, 'already_claimed');
  const regWhileClaimed = loadRegistry();
  assert.equal(regWhileClaimed.threads['thr-010'].lastSyncedStepIndex, undefined);
  assert.equal(regWhileClaimed.threads['thr-010'].pushedToCoordinatorAt || '', '');
  assert.equal(regWhileClaimed.threads['thr-010'].notifiedCoordinatorAt || '', '');
  rmSync(activeClaim, { force: true });

  // Step 3: Retry succeeds, persists markers, and deduplicates subsequent calls
  const sendLog = join(tempRoot, 'send-calls.jsonl');
  const okExe = writeMockAgentApiScript(
    tempRoot,
    'ok-api',
    `import { appendFileSync } from 'node:fs';
     appendFileSync(${JSON.stringify(sendLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: 'ok' } } }));`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = okExe;

  const okRes = await syncCompletionToCoordinator({ threadId: 'thr-010', force: false, timeoutMs: 5000 });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.synced, true);

  const regAfterOk = loadRegistry();
  const tAfterOk = regAfterOk.threads['thr-010'];
  assert.equal(tAfterOk.lastSyncedStepIndex, 5);
  assert.ok(tAfterOk.pushedToCoordinatorAt);
  assert.ok(tAfterOk.notifiedCoordinatorAt);

  const dedupRes = await syncCompletionToCoordinator({ threadId: 'thr-010', force: false });
  assert.equal(dedupRes.ok, true);
  assert.equal(dedupRes.synced, false);
  assert.equal(dedupRes.reason, 'already_synced');

  const logLines = readFileSync(sendLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(logLines.length, 1, 'must deliver exactly once after retry succeeds');

  // Step 4: Stale abandoned claim left by a dead PID (>2s old) is safely reclaimed
  const workerConv2 = 'conv-worker-00000011';
  const txDir2 = join(appDataDir, 'brain', workerConv2, '.system_generated', 'logs');
  mkdirSync(txDir2, { recursive: true });
  writeFileSync(
    join(txDir2, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      content: '### Thread Summary\nRecovered from stale claim.',
    }),
    'utf8',
  );
  const reg2 = loadRegistry();
  reg2.threads['thr-011'] = {
    threadId: 'thr-011',
    conversationId: workerConv2,
    coordinatorId: coordConvId,
    workspaceKey: '__test__',
    title: 'Stale claim test',
    model: 'flash',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    createdAt: '2026-11-27T01:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
  };
  saveRegistry(reg2);

  const staleClaim = join(claimsDir, 'thr-011-step-2.claim');
  writeFileSync(staleClaim, `${JSON.stringify({ pid: 999999999, at: '2026-11-27T00:00:00Z' })}\n`);
  const staleTime = new Date(Date.now() - 5000);
  utimesSync(staleClaim, staleTime, staleTime);

  const reclaimedRes = await syncCompletionToCoordinator({ threadId: 'thr-011', force: false, timeoutMs: 5000 });
  assert.equal(reclaimedRes.synced, true);
  assert.equal(loadRegistry().threads['thr-011'].lastSyncedStepIndex, 2);

  // Step 5: syncThreads keeps retrying a thread created before PROCESS_BOOT_ISO when initial sync fails
  const workerConv3 = 'conv-worker-00000012';
  const txDir3 = join(appDataDir, 'brain', workerConv3, '.system_generated', 'logs');
  mkdirSync(txDir3, { recursive: true });
  writeFileSync(
    join(txDir3, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      content: '### Thread Summary\nFinished after Sidecar restart.',
    }),
    'utf8',
  );
  const reg3 = loadRegistry();
  reg3.threads['thr-012'] = {
    threadId: 'thr-012',
    conversationId: workerConv3,
    coordinatorId: coordConvId,
    workspaceKey: '__test__',
    title: 'Sidecar retry test',
    model: 'flash',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
  };
  saveRegistry(reg3);

  // Mark seenRunningThreadIds while RUNNING
  await syncThreads({ allWorkspaces: true });

  // Transition to IDLE > 8s ago and fail first sync attempt
  const reg3Idle = loadRegistry();
  reg3Idle.threads['thr-012'].runState = 'RUN_STATE_IDLE';
  reg3Idle.threads['thr-012'].lastCompletedAt = new Date(Date.now() - 12000).toISOString();
  saveRegistry(reg3Idle);
  process.env.ANTIGRAVITY_AGENTAPI_EXE = failingExe;
  await syncThreads({ allWorkspaces: true });
  assert.equal(loadRegistry().threads['thr-012'].lastSyncedStepIndex, undefined);

  // Restore working agentapi; next syncThreads poll must retry and succeed
  process.env.ANTIGRAVITY_AGENTAPI_EXE = okExe;
  await syncThreads({ allWorkspaces: true });
  assert.equal(loadRegistry().threads['thr-012'].lastSyncedStepIndex, 4);
});

test('resolveAgentApiExe discovers bin/agentapi shims and arch-suffixed language_server binaries across platforms', (t) => {
  const { tempRoot } = createTempAntigravityEnv(t, 'pt-exe-');

  // 1. Direct ~/.gemini/antigravity/bin/agentapi shim on POSIX
  const posixAppData = join(tempRoot, 'posix-app');
  mkdirSync(join(posixAppData, 'bin'), { recursive: true });
  const posixShim = join(posixAppData, 'bin', 'agentapi');
  writeFileSync(posixShim, '#!/bin/sh\necho standalone\n', 'utf8');
  assert.equal(
    resolveAgentApiExe({
      platform: 'linux',
      arch: 'x64',
      execPath: join(tempRoot, 'node'),
      env: {},
      homeDir: tempRoot,
      appDataDir: posixAppData,
      installDirs: [],
    }),
    posixShim,
  );

  // 2. Direct ~/.gemini/antigravity/bin/agentapi.cmd shim on Windows
  const winAppData = join(tempRoot, 'win-app');
  mkdirSync(join(winAppData, 'bin'), { recursive: true });
  const winCmdShim = join(winAppData, 'bin', 'agentapi.cmd');
  writeFileSync(winCmdShim, '@echo off\r\necho standalone %*\r\n', 'utf8');
  assert.equal(
    resolveAgentApiExe({
      platform: 'win32',
      arch: 'x64',
      execPath: join(tempRoot, 'node.exe'),
      env: {},
      homeDir: tempRoot,
      appDataDir: winAppData,
      installDirs: [],
    }),
    winCmdShim,
  );

  // 3. Shim referencing arch-suffixed language_server_macos_arm target resolves directly to target
  const macAppData = join(tempRoot, 'mac-app');
  mkdirSync(join(macAppData, 'bin'), { recursive: true });
  const macTargetDir = join(tempRoot, 'Antigravity.app', 'Contents', 'Resources', 'bin');
  mkdirSync(macTargetDir, { recursive: true });
  const macLsArm = join(macTargetDir, 'language_server_macos_arm');
  writeFileSync(macLsArm, 'binary', 'utf8');
  writeFileSync(join(macAppData, 'bin', 'agentapi'), `#!/bin/sh\nexec "${macLsArm}" agentapi "$@"\n`, 'utf8');
  assert.equal(
    resolveAgentApiExe({
      platform: 'darwin',
      arch: 'arm64',
      execPath: join(tempRoot, 'node'),
      env: {},
      homeDir: tempRoot,
      appDataDir: macAppData,
      installDirs: [],
    }),
    macLsArm,
  );

  // 4. Install dir discovery for arch-suffixed binaries (Linux x64/arm64, macOS arm64/x64, Windows arm64)
  const linuxX64Dir = join(tempRoot, 'linux-x64', 'resources', 'bin');
  mkdirSync(linuxX64Dir, { recursive: true });
  const linuxX64Bin = join(linuxX64Dir, 'language_server_linux_x64');
  writeFileSync(linuxX64Bin, 'bin', 'utf8');
  assert.equal(
    resolveAgentApiExe({
      platform: 'linux',
      arch: 'x64',
      execPath: join(tempRoot, 'node'),
      env: {},
      homeDir: tempRoot,
      appDataDir: join(tempRoot, 'empty-app'),
      installDirs: [linuxX64Dir],
    }),
    linuxX64Bin,
  );

  const linuxArmDir = join(tempRoot, 'linux-arm64', 'resources', 'bin');
  mkdirSync(linuxArmDir, { recursive: true });
  const linuxArmBin = join(linuxArmDir, 'language_server_linux_arm64');
  writeFileSync(linuxArmBin, 'bin', 'utf8');
  assert.equal(
    resolveAgentApiExe({
      platform: 'linux',
      arch: 'arm64',
      execPath: join(tempRoot, 'node'),
      env: {},
      homeDir: tempRoot,
      appDataDir: join(tempRoot, 'empty-app'),
      installDirs: [linuxArmDir],
    }),
    linuxArmBin,
  );

  const winArmDir = join(tempRoot, 'win-arm64', 'resources', 'bin');
  mkdirSync(winArmDir, { recursive: true });
  const winArmBin = join(winArmDir, 'language_server_windows_arm64.exe');
  writeFileSync(winArmBin, 'bin', 'utf8');
  assert.equal(
    resolveAgentApiExe({
      platform: 'win32',
      arch: 'arm64',
      execPath: join(tempRoot, 'node.exe'),
      env: {},
      homeDir: tempRoot,
      appDataDir: join(tempRoot, 'empty-app'),
      installDirs: [winArmDir],
    }),
    winArmBin,
  );
});

test('resolveLsEndpoint falls back to live daemon/hub_*.json when ls-endpoint.json is absent or stale', (t) => {
  const { appDataDir, stateDir } = createTempAntigravityEnv(t, 'pt-ep-');
  const daemonDir = join(appDataDir, 'daemon');
  mkdirSync(daemonDir, { recursive: true });

  // 1. Dead hub is ignored; live hub is discovered when ls-endpoint.json is missing
  const deadHubPath = join(daemonDir, 'hub_55002.json');
  writeFileSync(
    deadHubPath,
    JSON.stringify({
      pid: 999999999,
      httpsPort: 55001,
      httpPort: 55002,
      csrfToken: 'dead-token',
    }),
  );
  const liveHubPath = join(daemonDir, 'hub_55012.json');
  writeFileSync(
    liveHubPath,
    JSON.stringify({
      pid: process.pid,
      httpsPort: 55011,
      httpPort: 55012,
      csrfToken: 'live-token',
    }),
  );

  const epFromDaemon = resolveLsEndpoint();
  assert.equal(epFromDaemon?.address, '127.0.0.1:55012');
  assert.equal(epFromDaemon?.csrfToken, 'live-token');

  // 2. Stale ls-endpoint.json pointing to dead port falls back to live hub
  const cachePath = join(stateDir, 'ls-endpoint.json');
  writeFileSync(
    cachePath,
    JSON.stringify({
      address: 'localhost:55002',
      csrfToken: 'stale-token',
      updatedAt: '2026-11-20T00:00:00Z',
    }),
  );
  const epAfterStale = resolveLsEndpoint();
  assert.equal(epAfterStale?.address, '127.0.0.1:55012');
  assert.equal(epAfterStale?.csrfToken, 'live-token');

  // 3. Fresh ls-endpoint.json matching live port is preserved
  writeFileSync(
    cachePath,
    JSON.stringify({
      address: 'localhost:55012',
      csrfToken: 'session-token',
      updatedAt: new Date().toISOString(),
    }),
  );
  const epFresh = resolveLsEndpoint();
  assert.equal(epFresh?.address, 'localhost:55012');
  assert.equal(epFresh?.csrfToken, 'session-token');
});

test('hooks.json and hook runner scripts satisfy cross-platform invocation and line-ending requirements', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));
  const lifecycle = hooks['project-threads-lifecycle'];
  assert.equal(lifecycle.enabled, true);
  assert.equal(lifecycle.PreInvocation[0].timeout, 5);
  assert.equal(lifecycle.PreToolUse[0].hooks[0].timeout, 5);
  assert.equal(lifecycle.Stop[0].timeout, 8);

  const cmds = [
    lifecycle.PreInvocation[0].command,
    lifecycle.PreToolUse[0].hooks[0].command,
    lifecycle.Stop[0].command,
  ];
  for (const cmd of cmds) {
    assert.match(cmd, /^set _='/, 'must guard Windows command in POSIX single quotes so sh never runs .cmd');
    assert.match(cmd, /run-hook\.cmd/);
    assert.match(cmd, /run-hook\.sh/);
  }

  const cmdBytes = readFileSync(new URL('../scripts/run-hook.cmd', import.meta.url));
  const shBytes = readFileSync(new URL('../scripts/run-hook.sh', import.meta.url));
  assert.ok(cmdBytes.includes(Buffer.from('\r\n')), 'scripts/run-hook.cmd must use CRLF');
  assert.ok(
    !cmdBytes.toString('utf8').replace(/\r\n/g, '').includes('\n'),
    'scripts/run-hook.cmd must not contain bare LF',
  );
  assert.ok(!shBytes.includes(Buffer.from('\r')), 'scripts/run-hook.sh must use LF');

  for (const mjsRel of ['../lib/ls-client.mjs', '../lib/store.mjs', '../scripts/hook-handler.mjs', '../tests/callback-pipeline.test.mjs']) {
    const mjsBytes = readFileSync(new URL(mjsRel, import.meta.url));
    assert.ok(!mjsBytes.includes(Buffer.from('\r')), `${mjsRel} must use LF`);
  }

  const shText = shBytes.toString('utf8');
  assert.match(shText, /\/opt\/homebrew\/bin\/node/);
  assert.match(shText, /\/usr\/local\/bin\/node/);
  assert.match(shText, /\.nvm\/versions\/node/);
  assert.match(shText, /\.volta\/bin\/node/);
  assert.match(shText, /fnm/);
  assert.match(shText, /\/usr\/share\/antigravity\/antigravity/);

  if (process.platform === 'win32') {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    for (const [cmd, expectedOut] of [
      [lifecycle.PreInvocation[0].command, '{}'],
      [lifecycle.PreToolUse[0].hooks[0].command, '{"decision":"allow"}'],
      [lifecycle.Stop[0].command, '{"decision":"stop"}'],
    ]) {
      const res = spawnSync(cmd, {
        shell: true,
        cwd: repoRoot,
        input: '{}',
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      assert.equal(res.stderr.trim(), '');
      assert.equal(res.stdout.trim(), expectedOut);
    }

    // Also verify run-hook.cmd works cleanly when PATH lacks node (standard paths / fallback)
    const cleanPathEnv = {
      ...process.env,
      PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    };
    const noPathRes = spawnSync(
      'cmd.exe',
      ['/d', '/c', join(repoRoot, 'scripts', 'run-hook.cmd'), 'Stop'],
      { cwd: repoRoot, env: cleanPathEnv, input: '{}', encoding: 'utf8' },
    );
    assert.equal(noPathRes.status, 0);
    assert.equal(noPathRes.stderr.trim(), '');
    assert.equal(noPathRes.stdout.trim(), '{"decision":"stop"}');
  }
});
