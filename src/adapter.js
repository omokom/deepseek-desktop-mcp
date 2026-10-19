import { setTimeout as delay } from 'node:timers/promises';
import {
  BRIDGE_NAME,
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_TITLE_CHARS,
  MAX_WORKSPACE_PATH_CHARS,
  modelDiagnostics,
} from './config.js';
import { createAdmissionLedger } from './ledger.js';
import {
  DEFAULT_GET_MAX_CHARS,
  DEFAULT_GET_MAX_EVENTS,
  MAX_GET_MAX_CHARS,
  MAX_GET_MAX_EVENTS,
  MAX_OUTPUT_CHARS,
  admissionRoute,
  buildTaskView,
  normalizeCursor,
  routeAllowed,
  visibleTextFromContent,
} from './task-view.js';
import {
  canonicalDirectoryPath,
  findAllowlistEntry,
  readWorkspaceAllowlist,
  sameWorkspacePath,
} from './workspaces.js';

export const MAX_TASK_CHARS = 100000;
export const MAX_CONTINUE_CHARS = 50000;
export const MAX_REQUEST_ID_CHARS = 200;
const PROMPT_TIMEOUT_MS = 15000;
const CANCEL_POLL_MS = 100;
const CANCEL_POLL_COUNT = 15;
const REQUIRED_ROUTE = 'deepseek-official/deepseek-flash/max';

function truncateCodePoints(value, maximum) {
  if (typeof value !== 'string') return null;
  const points = Array.from(value);
  return points.length <= maximum ? value : `${points.slice(0, maximum).join('')}…`;
}

function safeString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorCode(error, fallback = 'operation_failed') {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code;
  return fallback;
}

function safeMessage(error, fallback = 'Operation failed') {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function structuredError(code, message, operation) {
  const error = new Error(message);
  error.code = code;
  error.operation = operation;
  return error;
}

function failure(error, operation, fallbackCode) {
  return {
    ok: false,
    error: {
      code: errorCode(error, fallbackCode),
      message: safeMessage(error),
      operation: error?.operation ?? operation,
    },
  };
}

function methodPresence(service, names) {
  return Object.fromEntries(names.map((name) => [name, typeof service?.[name] === 'function']));
}

function normalizeRequestId(value) {
  if (typeof value !== 'string') throw structuredError('request_id_invalid', 'requestId must be a string', 'admission');
  const requestId = value.trim();
  if (requestId.length === 0 || requestId.length > MAX_REQUEST_ID_CHARS) {
    throw structuredError('request_id_invalid', `requestId must be 1..${MAX_REQUEST_ID_CHARS} characters`, 'admission');
  }
  if (/[\u0000-\u001f\u007f]/.test(requestId)) {
    throw structuredError('request_id_invalid', 'requestId must not contain control characters', 'admission');
  }
  return requestId;
}

function normalizeText(value, maximum, label) {
  if (typeof value !== 'string') throw structuredError(`${label}_invalid`, `${label} must be a string`, 'admission');
  const text = value.trim();
  if (text.length === 0) throw structuredError(`${label}_empty`, `${label} must not be empty`, 'admission');
  if (Array.from(text).length > maximum) {
    throw structuredError(`${label}_too_large`, `${label} exceeds ${maximum} characters`, 'admission');
  }
  return text;
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === 'auto') return 'auto';
  if (value === 'followup' || value === 'steer') return value;
  throw structuredError('mode_invalid', 'mode must be steer, followup, or omitted', 'admission');
}

function sessionPreset(observation) {
  const selected = observation.events.findLast((event) => event.type === 'agent-preset/selected');
  return selected ? (selected.data?.agentPreset ?? null)
    : (observation.projections?.values?.agentPreset ?? observation.header?.agentPreset ?? null);
}

function assertStandardPreset(observation) {
  const preset = sessionPreset(observation);
  if (preset !== 'standard') {
    throw structuredError('agent_preset_mismatch', `Session preset ${preset ?? '?'} is not standard; no prompt was submitted`, 'agent_preset');
  }
}

function defaultSelection(agentDefaultModel) {
  try {
    const value = agentDefaultModel?.currentSelection?.();
    if (value === null || typeof value !== 'object') return null;
    return {
      provider: typeof value.provider === 'string' ? value.provider : null,
      model: typeof value.model === 'string' ? value.model : null,
      reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null,
    };
  } catch {
    return null;
  }
}

function inboxFromAgent(agent) {
  try {
    const nextTurn = Array.isArray(agent?.inbox?.nextTurn) ? agent.inbox.nextTurn : [];
    const nextStep = Array.isArray(agent?.inbox?.nextStep) ? agent.inbox.nextStep : [];
    const items = [];
    for (const [target, list] of [['next-turn', nextTurn], ['next-step', nextStep]]) {
      for (const message of list.slice(0, 10)) {
        items.push({
          target,
          text: truncateCodePoints(visibleTextFromContent(message?.content) || '[untextual input]', 500),
        });
      }
    }
    return {
      known: true,
      nextTurnCount: nextTurn.length,
      nextStepCount: nextStep.length,
      items: items.slice(0, 20),
    };
  } catch {
    return { known: false, nextTurnCount: 0, nextStepCount: 0, items: [] };
  }
}

/**
 * Adapter over current Host services. Reads use sessionQuery observations;
 * mutations use only sessionController APIs. No Host class, Scope identity,
 * agent creation/disposal, model selection, or duplicate queue is used.
 */
export function createDesktopAdapter(input) {
  const {
    sessionController,
    workspaceRegistry,
    sessionQuery,
    agents,
    agentDefaultModel,
    workspaceId,
    stateFile,
    workspacesFile,
    getProfileContext,
    env = process.env,
  } = input;

  if (sessionController === undefined || sessionController === null) throw new Error('ctx.sessionController is unavailable');
  if (workspaceRegistry === undefined || workspaceRegistry === null) throw new Error('ctx.workspaceRegistry is unavailable');
  if (sessionQuery === undefined || sessionQuery === null) throw new Error('ctx.sessionQuery is unavailable');
  if (typeof stateFile !== 'string' || stateFile.trim() === '') throw new Error('admission state file is unavailable');

  const ledger = createAdmissionLedger(stateFile);
  const sessionErrors = new Map();

  function workspaceSnapshot() {
    let workspace;
    try {
      workspace = workspaceRegistry.get(workspaceId);
    } catch (error) {
      throw structuredError('workspace_lookup_failed', safeMessage(error, 'Workspace lookup failed'), 'workspace_membership');
    }
    if (workspace === undefined || workspace === null) {
      throw structuredError(
        'workspace_not_found',
        `configured workspace "${workspaceId}" was not found; refusing to list or dispatch`,
        'workspace_membership',
      );
    }

    let archived;
    try {
      archived = workspaceRegistry.archivedSessionIds;
    } catch (error) {
      throw structuredError(
        'workspace_archived_membership_failed',
        safeMessage(error, 'Workspace archived membership failed'),
        'workspace_membership',
      );
    }
    if (!Array.isArray(archived) || archived.some((id) => typeof id !== 'string')) {
      throw structuredError(
        'workspace_archived_membership_malformed',
        'Workspace archived membership is not a string array',
        'workspace_membership',
      );
    }

    let sessionIds;
    try {
      sessionIds = workspace.sessionIds;
    } catch (error) {
      throw structuredError(
        'workspace_session_membership_failed',
        safeMessage(error, 'Workspace session membership failed'),
        'workspace_membership',
      );
    }
    if (!Array.isArray(sessionIds) || sessionIds.some((id) => typeof id !== 'string')) {
      throw structuredError(
        'workspace_session_membership_malformed',
        'Workspace session membership is not a string array',
        'workspace_membership',
      );
    }

    const archivedSet = new Set(archived);
    const allowed = new Set(sessionIds.filter((id) => !archivedSet.has(id)));
    return { workspace, allowed, archivedCount: archivedSet.size };
  }

  function archivedIdSet() {
    let archived;
    try {
      archived = workspaceRegistry.archivedSessionIds;
    } catch (error) {
      throw structuredError(
        'workspace_archived_membership_failed',
        safeMessage(error, 'Workspace archived membership failed'),
        'workspace_membership',
      );
    }
    if (!Array.isArray(archived) || archived.some((id) => typeof id !== 'string')) {
      throw structuredError(
        'workspace_archived_membership_malformed',
        'Workspace archived membership is not a string array',
        'workspace_membership',
      );
    }
    return new Set(archived);
  }

  function readAllowlist() {
    if (typeof workspacesFile !== 'string' || workspacesFile.trim() === '') {
      return Promise.reject(structuredError(
        'workspace_allowlist_unavailable',
        'workspace allowlist is not configured; pass an enrolled workspacePath from the trusted local launcher',
        'workspace_membership',
      ));
    }
    return readWorkspaceAllowlist({ file: workspacesFile, env }).catch((error) => {
      throw structuredError(
        errorCode(error, 'workspace_allowlist_unavailable'),
        safeMessage(error, 'Workspace allowlist failed'),
        'workspace_membership',
      );
    });
  }

  function workspaceIdsOf(workspace) {
    let ids;
    try {
      ids = workspace.sessionIds;
    } catch (error) {
      throw structuredError('workspace_session_membership_failed', safeMessage(error, 'Workspace session membership failed'), 'workspace_membership');
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw structuredError('workspace_session_membership_malformed', 'Workspace session membership is not a string array', 'workspace_membership');
    }
    return ids;
  }

  function verifyWorkspaceMember(workspace, sessionId) {
    if (!workspaceIdsOf(workspace).includes(sessionId)) {
      throw structuredError('session_not_authorized', `session "${sessionId}" is not an active member of workspace "${workspace.path}"`, 'workspace_membership');
    }
  }

  /**
   * Verify that the session's own persisted header cwd agrees with the
   * workspace's canonical path. String normalization catches the normal Host
   * spelling; canonical resolution catches symlinked/loosely spelled stored
   * paths. When neither agrees the session is refused, never re-homed.
   */
  async function assertSessionCwd(workspace, header) {
    const cwd = header?.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw structuredError('session_cwd_unverified', `session header carries no stored cwd; refusing to address workspace "${workspace.path}"`, 'workspace_membership');
    }
    if (sameWorkspacePath(cwd, workspace.path)) return;
    try {
      const [canonicalCwd, canonicalWorkspace] = await Promise.all([
        canonicalDirectoryPath(cwd),
        canonicalDirectoryPath(workspace.path),
      ]);
      if (sameWorkspacePath(canonicalCwd, canonicalWorkspace)) return;
    } catch {
      // Fall through to the structured mismatch below.
    }
    throw structuredError('session_cwd_mismatch', `session stored cwd "${cwd}" does not match workspace path "${workspace.path}"`, 'workspace_membership');
  }

  /**
   * Resolve the workspace owning one session over the configured default
   * workspace plus every enrolled workspace. Membership and the stored cwd are
   * checked together; a session is never addressed through a supplied path.
   */
  async function resolveSessionWorkspace(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw structuredError('session_id_invalid', 'sessionId must be a non-empty string', 'workspace_membership');
    }
    const archived = archivedIdSet();
    const candidates = [];
    const seen = new Set();
    let configured;
    try {
      configured = workspaceRegistry.get(workspaceId);
    } catch (error) {
      throw structuredError('workspace_lookup_failed', safeMessage(error, 'Workspace lookup failed'), 'workspace_membership');
    }
    if (configured !== undefined && configured !== null && typeof configured.id === 'string') {
      candidates.push(configured);
      seen.add(configured.id);
    }
    let allowlist = null;
    let allowlistError = null;
    try {
      allowlist = await readAllowlist();
    } catch (error) {
      allowlistError = error;
    }
    if (allowlist !== null) {
      for (const entry of allowlist.entries) {
        let workspace;
        try {
          workspace = await workspaceRegistry.resolveByPath(entry.path);
        } catch {
          workspace = undefined;
        }
        if (workspace !== undefined && workspace !== null && typeof workspace.id === 'string' && !seen.has(workspace.id)) {
          candidates.push(workspace);
          seen.add(workspace.id);
        }
      }
    }
    if (candidates.length === 0) {
      if (allowlistError !== null) throw allowlistError;
      throw structuredError('workspace_not_found', `configured workspace "${workspaceId}" was not found; refusing to address sessions`, 'workspace_membership');
    }
    const matches = [];
    for (const workspace of candidates) {
      if (typeof workspace.path !== 'string' || archived.has(sessionId)) continue;
      if (workspaceIdsOf(workspace).includes(sessionId)) matches.push(workspace);
    }
    if (matches.length === 0) {
      // Surface an unreadable/corrupt allowlist instead of masking it as an
      // authorization failure: without the allowlist we cannot know whether
      // this session belongs to an enrolled (non-default) workspace.
      if (allowlistError !== null) throw allowlistError;
      throw structuredError('session_not_authorized', `session "${sessionId}" is not an active member of the configured or an enrolled workspace`, 'workspace_membership');
    }
    if (matches.length > 1) {
      throw structuredError('session_workspace_ambiguous', `session "${sessionId}" is accounted to more than one workspace; refusing to choose`, 'workspace_membership');
    }
    return { workspace: matches[0], allowlist };
  }

  /**
   * Resolve the admit target for submit_task. The default (no workspacePath)
   * keeps the configured workspace; an explicit workspacePath must be an exact
   * canonical allowlisted directory. A real workspace record is created only
   * here, at explicit submit, through workspaceRegistry.create.
   */
  async function resolveSubmitWorkspace(rawWorkspacePath) {
    if (rawWorkspacePath === undefined || rawWorkspacePath === null) {
      const snapshot = workspaceSnapshot();
      return { workspace: snapshot.workspace, canonicalPath: snapshot.workspace.path, created: false, default: true, allowlist: null };
    }
    if (typeof rawWorkspacePath !== 'string' || rawWorkspacePath.trim() === ''
      || Array.from(rawWorkspacePath).length > MAX_WORKSPACE_PATH_CHARS) {
      throw structuredError('workspace_path_invalid', `workspacePath must be a non-empty string of at most ${MAX_WORKSPACE_PATH_CHARS} characters`, 'workspace_membership');
    }
    let canonicalPath;
    try {
      canonicalPath = await canonicalDirectoryPath(rawWorkspacePath);
    } catch (error) {
      throw structuredError(errorCode(error, 'workspace_path_invalid'), safeMessage(error, 'workspacePath is invalid'), 'workspace_membership');
    }
    const allowlist = await readAllowlist();
    if (findAllowlistEntry(allowlist, canonicalPath) === undefined) {
      throw structuredError(
        'workspace_not_enrolled',
        `workspacePath "${canonicalPath}" is not in the workspace allowlist (${allowlist.file}); enroll exactly this existing directory from the trusted local launcher (-Workspace) or by coordinator approval. Roots, parents, globs, and unrelated paths are never authorized by this bridge.`,
        'workspace_membership',
      );
    }
    if (typeof workspaceRegistry.resolveByPath !== 'function' || typeof workspaceRegistry.create !== 'function') {
      throw structuredError('workspace_registry_unsupported', 'workspaceRegistry lacks resolveByPath/create; this Host cannot enroll extra workspaces', 'workspace_membership');
    }
    let workspace;
    try {
      workspace = await workspaceRegistry.resolveByPath(canonicalPath);
    } catch (error) {
      throw structuredError(errorCode(error, 'workspace_lookup_failed'), safeMessage(error, 'Workspace lookup failed'), 'workspace_membership');
    }
    let created = false;
    if (workspace === undefined || workspace === null) {
      try {
        workspace = await workspaceRegistry.create(canonicalPath, undefined);
      } catch (error) {
        throw structuredError(errorCode(error, 'workspace_create_failed'), safeMessage(error, 'Workspace creation failed'), 'workspace_membership');
      }
      created = true;
    }
    if (workspace === undefined || workspace === null || typeof workspace.id !== 'string' || typeof workspace.path !== 'string') {
      throw structuredError('workspace_create_malformed', 'workspaceRegistry returned a malformed workspace', 'workspace_membership');
    }
    if (!sameWorkspacePath(workspace.path, canonicalPath)) {
      throw structuredError('workspace_path_mismatch', `workspaceRegistry resolved "${workspace.path}" instead of the requested "${canonicalPath}"`, 'workspace_membership');
    }
    return { workspace, canonicalPath: workspace.path, created, default: false, allowlist };
  }

  async function observe(sessionId, signal) {
    let observation;
    try {
      observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'all' });
    } catch (error) {
      throw structuredError(
        errorCode(error, 'session_observation_failed'),
        safeMessage(error, 'Session observation failed'),
        'sessionQuery.observeSession',
      );
    }
    let events;
    try {
      events = observation?.events;
    } catch (error) {
      try {
        observation?.[Symbol.dispose]?.();
      } catch {
        // Ignore disposal failure while reporting the read failure.
      }
      throw structuredError(
        errorCode(error, 'session_observation_failed'),
        safeMessage(error, 'Session observation events failed'),
        'sessionQuery.observeSession',
      );
    }
    if (observation === null || typeof observation !== 'object' || !Array.isArray(events)) {
      try {
        observation?.[Symbol.dispose]?.();
      } catch {
        // Ignore disposal failure for an invalid observation.
      }
      throw structuredError('session_observation_malformed', 'sessionQuery returned a malformed observation', 'sessionQuery.observeSession');
    }
    return observation;
  }

  async function withObservation(sessionId, signal, callback) {
    const observation = await observe(sessionId, signal);
    try {
      return await callback(observation);
    } finally {
      try {
        observation[Symbol.dispose]?.();
      } catch {
        // Detached observation cleanup must not hide the operation result.
      }
    }
  }

  function readAgent(sessionId) {
    try {
      return agents?.get?.(sessionId);
    } catch {
      return undefined;
    }
  }

  function recordSessionError(sessionId, message, context = {}) {
    if (typeof sessionId !== 'string' || typeof message !== 'string' || message.trim() === '') return;
    let allowed;
    try {
      allowed = workspaceSnapshot().allowed;
    } catch {
      return;
    }
    if (!allowed.has(sessionId)) return;
    let seq = Number.isInteger(context.seq) ? context.seq : undefined;
    if (seq === undefined) {
      try {
        const agent = readAgent(sessionId);
        if (typeof agent?.session?.seq === 'number') seq = agent.session.seq;
      } catch {
        seq = undefined;
      }
    }
    const list = sessionErrors.get(sessionId) ?? [];
    list.push({
      message: truncateCodePoints(message, 1000),
      at: Date.now(),
      ...(seq === undefined ? {} : { seq }),
    });
    sessionErrors.set(sessionId, list.slice(-5));
  }

  function errorsFor(sessionId) {
    return sessionErrors.get(sessionId) ?? [];
  }

  function beginAdmission(sessionId) {
    if (typeof sessionId === 'string') sessionErrors.delete(sessionId);
  }

  async function listSessions(limit = DEFAULT_LIST_LIMIT, signal) {
    const requested = Number.isInteger(limit) ? limit : DEFAULT_LIST_LIMIT;
    const bounded = Math.min(MAX_LIST_LIMIT, Math.max(1, requested));
    let snapshot;
    try {
      snapshot = workspaceSnapshot();
    } catch (error) {
      return failure(error, 'workspace_membership', 'workspace_membership_failed');
    }
    const { workspace, allowed } = snapshot;
    let response;
    try {
      response = await sessionController.list({}, signal);
    } catch (error) {
      return failure(error, 'sessionController.list', 'session_list_failed');
    }
    if (response === null || typeof response !== 'object' || !Array.isArray(response.items)) {
      return failure(
        structuredError('controller_list_malformed', 'sessionController.list did not return an items array', 'sessionController.list'),
        'sessionController.list',
      );
    }
    if (response.items.some((row) => row === null || typeof row !== 'object' || typeof row.sessionId !== 'string')) {
      return failure(
        structuredError('controller_list_malformed', 'sessionController.list returned a row without a string sessionId', 'sessionController.list'),
        'sessionController.list',
      );
    }
    const filtered = response.items.filter((row) => allowed.has(row.sessionId));
    const items = filtered.slice(0, bounded).map((row) => ({
      sessionId: row.sessionId,
      title: truncateCodePoints(row.projections?.values?.title, MAX_TITLE_CHARS),
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : null,
      running: row.running === true,
      agentAvailable: row.agentAvailable === true,
      blank: row.blank === true,
      formatStatus: safeString(row.formatStatus),
    }));
    return {
      ok: true,
      workspaceId,
      workspacePath: workspace.path,
      total: filtered.length,
      limit: bounded,
      hasMore: filtered.length > bounded,
      items,
    };
  }

  function routeFailure(route) {
    return failure(
      structuredError(
        'model_route_mismatch',
        `Session route ${route.provider ?? '?'}/${route.model ?? '?'}/${route.reasoningEffort ?? '?'} does not match required ${REQUIRED_ROUTE}`,
        'model_route',
      ),
      'model_route',
      'model_route_mismatch',
    );
  }

  function assertEntryWorkspace(entry, workspace) {
    const expectedId = typeof entry.workspaceId === 'string' ? entry.workspaceId : workspaceId;
    if (expectedId !== workspace.id) {
      throw structuredError('request_id_conflict', `requestId "${entry.requestId ?? '?'}" belongs to workspace "${expectedId}", not "${workspace.id}"`, 'admission');
    }
    if (typeof entry.workspacePath === 'string' && !sameWorkspacePath(entry.workspacePath, workspace.path)) {
      throw structuredError('request_id_conflict', `requestId "${entry.requestId ?? '?'}" belongs to workspace "${entry.workspacePath}", not "${workspace.path}"`, 'admission');
    }
  }

  async function promptAdmission({ requestId, entry, text, mode, tx, workspace }) {
    try {
      verifyWorkspaceMember(workspace, entry.sessionId);
      return await withObservation(entry.sessionId, undefined, async (observation) => {
        await assertSessionCwd(workspace, observation.header);
        assertStandardPreset(observation);
        const route = admissionRoute(observation.events, observation.projections, defaultSelection(agentDefaultModel));
        if (!routeAllowed(route)) {
          return {
            ...routeFailure(route),
            route,
            required: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
          };
        }
        // A prepared admission must be durable immediately before any prompt,
        // including a retry of a previously prepared entry.
        try {
          await tx.flush();
        } catch (error) {
          return failure(error, 'admission', 'admission_state_write_failed');
        }
        beginAdmission(entry.sessionId);
        let accepted;
        try {
          accepted = await sessionController.prompt({
            sessionId: entry.sessionId,
            content: [{ type: 'text', text }],
            requestId,
            ...(mode === 'steer' ? { mode: 'steer' } : {}),
          }, AbortSignal.timeout(PROMPT_TIMEOUT_MS));
        } catch (error) {
          return failure(error, 'sessionController.prompt', 'prompt_failed');
        }
        if (accepted?.accepted !== true) {
          return failure(structuredError('prompt_not_accepted', 'sessionController.prompt did not acknowledge admission', 'sessionController.prompt'));
        }
        const admitted = {
          ...entry,
          phase: 'admitted',
          mode,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          admittedAt: Date.now(),
          updatedAt: Date.now(),
        };
        tx.put(requestId, admitted);
        try {
          await tx.flush();
        } catch (error) {
          return failure(error, 'admission', 'admission_state_write_failed');
        }
        return {
          ok: true,
          sessionId: entry.sessionId,
          requestId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          admission: 'accepted',
          agentPreset: sessionPreset(observation),
          admitted: true,
          completion: false,
          status: 'admitted',
          mode,
        };
      });
    } catch (error) {
      return failure(error, 'sessionController.prompt', 'prompt_failed');
    }
  }

  async function resumeAdmission({ requestId, entry, text, tx, workspace }) {
    assertEntryWorkspace(entry, workspace);
    if (entry.phase === 'admitted') {
      verifyWorkspaceMember(workspace, entry.sessionId);
      return await withObservation(entry.sessionId, undefined, async (observation) => {
        await assertSessionCwd(workspace, observation.header);
        assertStandardPreset(observation);
        return {
          ok: true,
          agentPreset: sessionPreset(observation),
          sessionId: entry.sessionId,
          requestId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          admission: 'already_admitted',
          admitted: true,
          completion: false,
          status: 'admitted',
          mode: entry.mode ?? 'followup',
        };
      });
    }
    if (entry.phase !== 'prepared') {
      return failure(structuredError('admission_state_invalid', `admission "${requestId}" has an unsupported phase`, 'admission'));
    }
    return promptAdmission({ requestId, entry, text, mode: entry.mode ?? 'followup', tx, workspace });
  }

  async function workspaceKeyFor(rawWorkspacePath) {
    if (rawWorkspacePath === undefined || rawWorkspacePath === null) return '';
    if (typeof rawWorkspacePath !== 'string' || rawWorkspacePath.trim() === ''
      || Array.from(rawWorkspacePath).length > MAX_WORKSPACE_PATH_CHARS) {
      throw structuredError('workspace_path_invalid', `workspacePath must be a non-empty string of at most ${MAX_WORKSPACE_PATH_CHARS} characters`, 'admission');
    }
    try {
      return await canonicalDirectoryPath(rawWorkspacePath);
    } catch (error) {
      throw structuredError(errorCode(error, 'workspace_path_invalid'), safeMessage(error, 'workspacePath is invalid'), 'admission');
    }
  }

  async function submitTask({ requestId: rawRequestId, task, workspacePath: rawWorkspacePath } = {}) {
    let requestId;
    let text;
    let workspaceKey;
    try {
      requestId = normalizeRequestId(rawRequestId);
      text = normalizeText(task, MAX_TASK_CHARS, 'task');
      workspaceKey = await workspaceKeyFor(rawWorkspacePath);
    } catch (error) {
      return failure(error, 'admission');
    }
    try {
      return await ledger.transaction(async (tx) => {
        const inputHash = tx.hashInput('submit', workspaceKey, text, 'followup');
        const existing = tx.get(requestId);
        if (existing !== undefined) {
          if (existing.kind !== 'submit' || existing.inputHash !== inputHash) {
            return failure(structuredError('request_id_conflict', `requestId "${requestId}" was already used with different input`, 'admission'));
          }
          let workspace;
          try {
            workspace = (await resolveSessionWorkspace(existing.sessionId)).workspace;
          } catch (error) {
            return failure(error, 'workspace_membership', 'workspace_membership_failed');
          }
          return resumeAdmission({ requestId, entry: existing, text, tx, workspace });
        }

        let resolved;
        try {
          resolved = await resolveSubmitWorkspace(rawWorkspacePath);
        } catch (error) {
          return failure(error, 'workspace_membership', 'workspace_membership_failed');
        }
        const workspace = resolved.workspace;

        let created;
        try {
          created = await sessionController.create({ workspaceId: workspace.id, agentPreset: 'standard' });
        } catch (error) {
          return failure(error, 'sessionController.create', 'session_create_failed');
        }
        const sessionId = created?.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return failure(structuredError('session_create_malformed', 'sessionController.create returned no sessionId', 'sessionController.create'));
        }
        try {
          verifyWorkspaceMember(workspace, sessionId);
        } catch (error) {
          return failure(error, 'workspace_membership');
        }

        const entry = {
          kind: 'submit',
          sessionId,
          inputHash,
          phase: 'prepared',
          mode: 'followup',
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tx.put(requestId, entry);
        try {
          await tx.flush();
        } catch (error) {
          return failure(error, 'admission', 'admission_state_write_failed');
        }
        return promptAdmission({ requestId, entry, text, mode: 'followup', tx, workspace });
      });
    } catch (error) {
      return failure(error, 'admission');
    }
  }

  async function continueTask({ sessionId, requestId: rawRequestId, text: rawText, mode: rawMode } = {}) {
    let requestId;
    let text;
    let requestedMode;
    try {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw structuredError('session_id_invalid', 'sessionId must be a non-empty string', 'admission');
      requestId = normalizeRequestId(rawRequestId);
      text = normalizeText(rawText, MAX_CONTINUE_CHARS, 'text');
      requestedMode = normalizeMode(rawMode);
    } catch (error) {
      return failure(error, 'admission');
    }
    try {
      return await ledger.transaction(async (tx) => {
        const inputHash = tx.hashInput('continue', sessionId, text, requestedMode);
        const existing = tx.get(requestId);
        if (existing !== undefined) {
          if (existing.kind !== 'continue' || existing.sessionId !== sessionId || existing.inputHash !== inputHash) {
            return failure(structuredError('request_id_conflict', `requestId "${requestId}" was already used with different input`, 'admission'));
          }
          let workspace;
          try {
            workspace = (await resolveSessionWorkspace(sessionId)).workspace;
          } catch (error) {
            return failure(error, 'workspace_membership', 'workspace_membership_failed');
          }
          return resumeAdmission({ requestId, entry: existing, text, tx, workspace });
        }

        let workspace;
        try {
          workspace = (await resolveSessionWorkspace(sessionId)).workspace;
        } catch (error) {
          return failure(error, 'workspace_membership', 'workspace_membership_failed');
        }

        const agent = readAgent(sessionId);
        let mode = requestedMode;
        if (mode === 'auto') mode = agent?.status === 'running' ? 'steer' : 'followup';
        if (mode === 'steer' && agent?.status !== 'running') {
          return failure(structuredError('steer_requires_running', 'steer requires a currently running session; use followup or omit mode', 'admission'));
        }

        const entry = {
          kind: 'continue',
          sessionId,
          inputHash,
          phase: 'prepared',
          mode,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        tx.put(requestId, entry);
        try {
          await tx.flush();
        } catch (error) {
          return failure(error, 'admission', 'admission_state_write_failed');
        }
        return promptAdmission({ requestId, entry, text, mode, tx, workspace });
      });
    } catch (error) {
      return failure(error, 'admission');
    }
  }

  async function getTask({ sessionId, cursor, maxEvents, maxChars } = {}) {
    try {
      const boundedCursor = normalizeCursor(cursor);
      const { workspace } = await resolveSessionWorkspace(sessionId);
      return await withObservation(sessionId, undefined, async (observation) => {
        if (observation.header?.id !== sessionId) {
          return failure(structuredError('session_identity_mismatch', 'sessionQuery returned a different session id', 'sessionQuery.observeSession'));
        }
        await assertSessionCwd(workspace, observation.header);
        const agent = readAgent(sessionId);
        const view = buildTaskView({
          events: observation.events,
          projections: observation.projections,
          agent,
          transientErrors: errorsFor(sessionId),
          cursor: boundedCursor,
          maxEvents,
          maxChars,
        });
        const title = observation.projections?.values?.title;
        return {
          ok: true,
          sessionId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          title: typeof title === 'string' ? title : null,
          agentPreset: sessionPreset(observation),
          agentAvailable: agent !== undefined,
          running: agent?.status === 'running',
          ...view,
        };
      });
    } catch (error) {
      return failure(error, 'get_task', 'get_task_failed');
    }
  }

  async function cancelTask({ sessionId } = {}) {
    try {
      const { workspace } = await resolveSessionWorkspace(sessionId);
      // Refuse a mismatched/absent stored cwd before mutating the session.
      await withObservation(sessionId, undefined, async (observation) => {
        if (observation.header?.id !== sessionId) {
          throw structuredError('session_identity_mismatch', 'sessionQuery returned a different session id', 'workspace_membership');
        }
        await assertSessionCwd(workspace, observation.header);
      });
      const before = readAgent(sessionId);
      if (before === undefined) {
        return failure(structuredError('session_not_attached', `session "${sessionId}" is not attached; no active turn can be cancelled`, 'sessionController.cancel'));
      }
      const seqBefore = typeof before.session?.seq === 'number' ? before.session.seq : null;
      const runningBefore = before.status === 'running';
      let accepted;
      try {
        accepted = await sessionController.cancel({ sessionId });
      } catch (error) {
        return failure(error, 'sessionController.cancel', 'cancel_failed');
      }
      let after = readAgent(sessionId);
      for (let index = 0; index < CANCEL_POLL_COUNT && after?.status === 'running'; index += 1) {
        await delay(CANCEL_POLL_MS);
        after = readAgent(sessionId);
      }
      const pendingInbox = after === undefined ? { known: false, nextTurnCount: 0, nextStepCount: 0, items: [] } : inboxFromAgent(after);
      let turnEndObserved = null;
      if (seqBefore !== null) {
        try {
          turnEndObserved = await withObservation(sessionId, undefined, async (observation) => {
            return observation.events.some((event) => event?.type === 'turn/end'
              && typeof event.seq === 'number'
              && event.seq > seqBefore
              && event.data?.reason?.kind === 'aborted');
          });
        } catch {
          turnEndObserved = null;
        }
      }
      const stopObserved = runningBefore
        && after !== undefined
        && (turnEndObserved === true || after.status !== 'running');
      const pendingCount = pendingInbox.nextTurnCount + pendingInbox.nextStepCount;
      const note = pendingInbox.known === false
        ? 'Cancellation requested, but pending inbox state could not be observed; do not infer that the session is stopped or empty.'
        : pendingCount > 0
          ? 'Cancellation requested; pending inbox work remains and may still run. This does not stop the whole session.'
          : 'Cancellation requested. The session was not disposed and no inbox was cleared.';
      return {
        ok: true,
        sessionId,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        cancelRequested: true,
        accepted: accepted?.accepted === true,
        runningBefore,
        runningAfter: after?.status ?? 'unknown',
        stopObserved,
        turnEndObserved,
        pendingInbox,
        note,
      };
    } catch (error) {
      return failure(error, 'cancel_task', 'cancel_failed');
    }
  }

  function diagnostics() {
    const { workspace, allowed, archivedCount } = workspaceSnapshot();
    const profile = (() => {
      try {
        const value = getProfileContext?.();
        return value && typeof value === 'object' && typeof value.name === 'string' ? { name: value.name } : null;
      } catch {
        return null;
      }
    })();
    const appVersion = safeString(env.DSH_CLIENT_VERSION);
    return {
      ok: true,
      bridge: {
        name: BRIDGE_NAME,
        version: BRIDGE_VERSION,
        protocol: BRIDGE_PROTOCOL,
        workspacePath: true,
        workspaceAllowlist: true,
        standardMode: true,
      },
      host: {
        pid: process.pid,
        appVersion,
        versionSource: appVersion === null ? 'unavailable' : 'DSH_CLIENT_VERSION',
        node: process.versions.node ?? null,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch,
        profile,
      },
      model: modelDiagnostics(agentDefaultModel),
      workspace: {
        id: workspaceId,
        path: safeString(workspace.path),
        sessionCount: allowed.size,
        archivedCount,
        configuredOnly: true,
      },
      workspaces: {
        allowlistFile: typeof workspacesFile === 'string' && workspacesFile.trim() !== '' ? workspacesFile : null,
        note: 'submit_task(workspacePath) accepts only exact canonical directories in this non-secret allowlist; workspace records are created only at explicit submit',
      },
      controller: {
        service: 'ctx.sessionController',
        access: 'trusted in-process service call (ctx.invocation undefined outside a Remote call)',
        methods: methodPresence(sessionController, ['list', 'page', 'create', 'prompt', 'cancel']),
        liveProbe: 'list/create/prompt/cancel observed live in B2 proof sessions',
      },
      sessionQuery: {
        service: 'ctx.sessionQuery',
        observeSession: typeof sessionQuery.observeSession === 'function',
      },
      capabilities: {
        list_sessions: 'implemented',
        submit_task: 'implemented',
        get_task: 'implemented',
        continue_task: 'implemented',
        cancel_task: 'implemented',
        workspacePath: 'implemented',
      },
      limits: {
        defaultListLimit: DEFAULT_LIST_LIMIT,
        maxListLimit: MAX_LIST_LIMIT,
        maxTitleChars: MAX_TITLE_CHARS,
        maxTaskChars: MAX_TASK_CHARS,
        maxContinueChars: MAX_CONTINUE_CHARS,
        maxRequestIdChars: MAX_REQUEST_ID_CHARS,
        defaultGetMaxEvents: DEFAULT_GET_MAX_EVENTS,
        maxGetMaxEvents: MAX_GET_MAX_EVENTS,
        defaultGetMaxChars: DEFAULT_GET_MAX_CHARS,
        maxGetMaxChars: MAX_GET_MAX_CHARS,
        maxOutputChars: MAX_OUTPUT_CHARS,
      },
      auth: {
        mode: 'bearer',
        loopbackOnly: true,
        bindHost: '127.0.0.1',
        sessionBodiesReturned: true,
        note: 'session bodies are returned only through authorized get_task visible items; raw headers, reasoning, and unrelated sessions are excluded',
      },
      notices: [
        'Default model and permission settings are not changed by this plugin.',
        'Only sessions accounted to the configured default workspace or an enrolled workspace are listed or addressed, and their stored header cwd must agree with that workspace path.',
        'submit_task(workspacePath) enrolls a directory only through workspaceRegistry.create at explicit submit, and only for an exact directory in the non-secret allowlist.',
        'Admission is not completion; get_task reports durable completion/error evidence.',
        'Cancellation retains pending inbox work and does not dispose the session.',
      ],
    };
  }

  return {
    workspaceId,
    listSessions,
    submitTask,
    getTask,
    continueTask,
    cancelTask,
    diagnostics,
    workspaceSnapshot,
    recordSessionError,
    beginAdmission,
  };
}
