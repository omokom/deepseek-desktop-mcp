/**
 * Test stand-ins only. Nothing here talks to the live Desktop Host.
 * The label is intentionally loud so test output cannot be mistaken for a live
 * compatibility or dispatch result.
 */
import { basename } from 'node:path';
import { sameWorkspacePath } from './workspaces.js';

export const FAKE_LABEL = 'FAKE test stand-in — not a live Desktop Host';

function fakeEvent(type, data, seq) {
  return { type, data, seq, time: 1_700_000_000_000 + seq };
}

/**
 * Build a fake Host with the services the bridge consumes:
 * workspaceRegistry, sessionController, sessionQuery, agents, and
 * agentDefaultModel. It models several workspaces (create/resolveByPath/list)
 * and per-session stored header cwd so workspace authorization can be tested
 * without a live Host.
 */
export function createFakeDesktop(options = {}) {
  const workspaceId = options.workspaceId ?? '3261eb3a-9083-4ce6-b18f-89cb7e6d1746';
  const workspacePath = options.workspacePath ?? 'C:/fake/deepseek-harness/default-workspace';
  const sessions = new Map();
  const workspaceSessionIds = options.workspaceSessionIds ?? [
    'fake-session-a',
    'fake-session-b',
    'fake-session-archived',
  ];
  const archivedSessionIds = options.archivedSessionIds ?? ['fake-session-archived'];
  const model = options.model ?? { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' };
  const calls = [];
  const saveSelectionCalls = [];
  const errorListeners = [];
  const effects = [];
  const logs = [];
  let nextId = 1;
  let nextWorkspaceId = 1;

  const defaultWorkspace = {
    id: workspaceId,
    path: workspacePath,
    title: 'Default workspace',
    sessionIds: [...workspaceSessionIds],
  };
  const workspaces = new Map([[workspaceId, defaultWorkspace]]);

  function addWorkspace({ path, title } = {}) {
    const id = `fake-workspace-${nextWorkspaceId++}`;
    const workspace = {
      id,
      path,
      title: title ?? basename(String(path)),
      sessionIds: [],
    };
    workspaces.set(id, workspace);
    return workspace;
  }

  function addSession({
    sessionId = `fake-created-${nextId++}`,
    events = [],
    title = null,
    status = 'idle',
    inbox = { nextTurn: [], nextStep: [] },
    modelSelection = { lastUsed: null, next: null },
    userQuestions = { active: [], settled: [] },
    plan = { active: false, pending: false },
    cwd,
    agentPreset = 'standard',
    workspaceId: targetWorkspaceId = workspaceId,
    foreign = false,
  } = {}) {
    const workspace = !foreign ? workspaces.get(targetWorkspaceId) : undefined;
    const entry = {
      id: sessionId,
      events: events.slice(),
      status,
      inbox,
      agentPreset,
      cwd: cwd ?? workspace?.path ?? workspacePath,
      workspaceId: foreign ? null : (workspace?.id ?? null),
      projections: {
        asOfSeq: events.at(-1)?.seq ?? -1,
        values: {
          title,
          modelSelection,
          inbox: { 'next-turn': inbox.nextTurn, 'next-step': inbox.nextStep },
          userQuestions,
          plan,
          permissions: { currentValue: 'default' },
        },
      },
      disposed: false,
    };
    sessions.set(sessionId, entry);
    if (!foreign && workspace !== undefined && !workspace.sessionIds.includes(sessionId)) {
      workspace.sessionIds.push(sessionId);
    }
    return entry;
  }

  addSession({
    sessionId: 'fake-session-a',
    title: 'Fake proof session A',
    workspaceId,
    modelSelection: { lastUsed: { ...model }, next: { ...model } },
  });
  addSession({
    sessionId: 'fake-session-b',
    title: 'Fake proof session B',
    status: 'running',
    workspaceId,
    modelSelection: { lastUsed: { ...model }, next: { ...model } },
  });
  addSession({
    sessionId: 'fake-session-archived',
    title: 'Fake archived session',
    workspaceId,
    modelSelection: { lastUsed: { ...model }, next: { ...model } },
  });
  addSession({
    sessionId: 'fake-session-other-workspace',
    title: 'Fake session outside the fence',
    foreign: true,
    modelSelection: { lastUsed: { ...model }, next: { ...model } },
  });

  function promptDeduped(session, requestId) {
    return session.events.some((event) => event.type === 'user/message' && event.data?.source?.rpcId === requestId);
  }

  function append(session, type, data) {
    const seq = (session.events.at(-1)?.seq ?? -1) + 1;
    session.events.push(fakeEvent(type, data, seq));
    if (session.projections) session.projections.asOfSeq = seq;
    return session.events.at(-1);
  }

  const sessionController = {
    async list() {
      calls.push({ operation: 'list' });
      return {
        items: [...sessions.values()].map((session) => ({
          sessionId: session.id,
          updatedAt: 1_700_000_000_000 + (session.events.at(-1)?.seq ?? 0),
          running: session.status === 'running',
          agentAvailable: true,
          blank: session.events.length === 0,
          formatStatus: 'current',
          projections: { values: { title: session.projections.values.title } },
        })),
      };
    },
    async create({ workspaceId: requestedWorkspaceId, agentPreset = options.defaultAgentPreset ?? 'standard' }) {
      calls.push({ operation: 'create', workspaceId: requestedWorkspaceId });
      const requested = requestedWorkspaceId ?? workspaceId;
      const workspace = workspaces.get(requested);
      if (workspace === undefined) {
        const error = new Error(`workspace "${requested}" not found`);
        error.code = 'workspace/not-found';
        throw error;
      }
      const session = addSession({ title: null, status: 'idle', workspaceId: requested, agentPreset });
      if (!workspace.sessionIds.includes(session.id)) workspace.sessionIds.push(session.id);
      return { sessionId: session.id };
    },
    async prompt(request, signal) {
      calls.push({ operation: 'prompt', sessionId: request.sessionId, requestId: request.requestId, mode: request.mode ?? 'followup' });
      if (signal?.aborted) {
        const error = new Error('prompt aborted');
        error.code = 'gateway/cancelled';
        throw error;
      }
      const session = sessions.get(request.sessionId);
      if (session === undefined) {
        const error = new Error('session not found');
        error.code = 'session/not-found';
        throw error;
      }
      if (promptDeduped(session, request.requestId)) return { accepted: true };
      append(session, 'user/message', {
        content: request.content,
        source: { kind: 'user', rpcId: request.requestId },
      });
      if (options.onPrompt !== undefined) {
        await options.onPrompt({
          session,
          request,
          raw: {
            append: (type, data) => append(session, type, data),
            setStatus: (status) => { session.status = status; },
          },
        });
      }
      return { accepted: true };
    },
    async cancel({ sessionId }) {
      calls.push({ operation: 'cancel', sessionId });
      const session = sessions.get(sessionId);
      if (session === undefined) {
        const error = new Error('session not attached');
        error.code = 'session/not-found';
        throw error;
      }
      session.status = 'idle';
      if (options.onCancel !== undefined) {
        await options.onCancel({
          session,
          raw: {
            append: (type, data) => append(session, type, data),
            setStatus: (status) => { session.status = status; },
          },
        });
      } else {
        append(session, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
      }
      return { accepted: true };
    },
    async page() {
      calls.push({ operation: 'page' });
      throw new Error('fake page should not be used by B');
    },
  };

  const sessionQuery = {
    async observeSession(sessionId, { signal, projectionMode = 'all' } = {}) {
      calls.push({ operation: 'observeSession', sessionId });
      if (signal?.aborted) {
        const error = new Error('observation aborted');
        error.code = 'SESSION_QUERY_ABORTED';
        throw error;
      }
      const session = sessions.get(sessionId);
      if (session === undefined) {
        const error = new Error(`session "${sessionId}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      const clones = session.events.map((event) => structuredClone(event));
      return {
        source: 'live',
        header: { id: session.id, cwd: session.cwd, agentPreset: session.agentPreset },
        inheritedEventCount: 0,
        events: clones,
        cursor: clones.at(-1)?.seq ?? -1,
        ...(projectionMode === 'none' ? {} : { projections: structuredClone(session.projections) }),
        retain() {
          return this;
        },
        [Symbol.dispose]() {
          session.disposed = true;
        },
      };
    },
  };

  const agents = {
    get(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      return {
        id: session.id,
        status: session.status,
        session: { id: session.id, seq: session.events.length },
        inbox: {
          nextTurn: session.inbox.nextTurn,
          nextStep: session.inbox.nextStep,
        },
      };
    },
  };

  const agentDefaultModel = {
    currentSelection() {
      return { ...model };
    },
    async saveSelection(value) {
      saveSelectionCalls.push(value);
      throw new Error('selectModel/saveSelection must not be called by the bridge');
    },
  };

  const workspaceRegistry = {
    get(id) {
      return workspaces.get(id);
    },
    list() {
      return [...workspaces.values()];
    },
    async resolveByPath(path) {
      for (const workspace of workspaces.values()) {
        if (sameWorkspacePath(workspace.path, path) || workspace.path === path) return workspace;
      }
      return undefined;
    },
    async create(path, title) {
      calls.push({ operation: 'createWorkspace', path, title });
      for (const workspace of workspaces.values()) {
        if (sameWorkspacePath(workspace.path, path) || workspace.path === path) return workspace;
      }
      return addWorkspace({ path, title });
    },
    get archivedSessionIds() {
      return archivedSessionIds;
    },
  };

  const ctx = {
    sessionController,
    workspaceRegistry,
    sessionQuery,
    agents,
    agentDefaultModel,
    get(name) {
      if (name === 'profileContext') return { name: 'desktop' };
      if (name === 'agentDefaultModel') return agentDefaultModel;
      return undefined;
    },
    logger: {
      info(...args) {
        logs.push({ level: 'info', args });
      },
      error(...args) {
        logs.push({ level: 'error', args });
      },
      warn(...args) {
        logs.push({ level: 'warn', args });
      },
    },
    on(name, handler) {
      if (name === 'api-session/error') {
        errorListeners.push(handler);
        return () => {
          const index = errorListeners.indexOf(handler);
          if (index >= 0) errorListeners.splice(index, 1);
        };
      }
      return () => {};
    },
    async effect(setup) {
      const cleanup = await setup();
      effects.push(cleanup);
      return cleanup;
    },
    async dispose() {
      while (effects.length > 0) await effects.pop()();
    },
  };

  return {
    label: FAKE_LABEL,
    ctx,
    calls,
    effects,
    logs,
    workspace: defaultWorkspace,
    workspaces,
    workspaceId,
    workspacePath,
    model,
    sessions,
    saveSelectionCalls,
    addSession,
    addWorkspace,
    append: (sessionId, type, data) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`no fake session ${sessionId}`);
      return append(session, type, data);
    },
    setStatus: (sessionId, status) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`no fake session ${sessionId}`);
      session.status = status;
    },
    emitError: (sessionId, message) => {
      for (const handler of errorListeners) handler(sessionId, message);
    },
    setProjections: (sessionId, values) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`no fake session ${sessionId}`);
      session.projections.values = { ...session.projections.values, ...values };
    },
  };
}
