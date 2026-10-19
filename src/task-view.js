import { REQUIRED_MODEL, REQUIRED_PROVIDER, REQUIRED_REASONING } from './config.js';

export const DEFAULT_GET_MAX_EVENTS = 40;
export const MAX_GET_MAX_EVENTS = 200;
export const DEFAULT_GET_MAX_CHARS = 12000;
export const MAX_GET_MAX_CHARS = 60000;
export const MAX_OUTPUT_CHARS = 60000;

export function normalizeCursor(value) {
  if (value === undefined || value === null) return { seq: -1, offset: 0 };
  if (typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('cursor must be an object'), { code: 'cursor_invalid' });
  const seq = value.seq ?? -1;
  const offset = value.offset ?? 0;
  if (!Number.isInteger(seq) || seq < -1) throw Object.assign(new Error('cursor.seq must be an integer >= -1'), { code: 'cursor_invalid' });
  if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error('cursor.offset must be an integer >= 0'), { code: 'cursor_invalid' });
  if (seq === -1 && offset !== 0) throw Object.assign(new Error('cursor.offset must be 0 when seq is -1'), { code: 'cursor_invalid' });
  return { seq, offset };
}

function codePointSlice(text, start, count) {
  const points = Array.from(text);
  const slice = points.slice(start, start + count);
  return { text: slice.join(''), nextOffset: start + slice.length, remaining: points.length > start + slice.length };
}

function truncate(value, maximum) {
  if (typeof value !== 'string') return null;
  const points = Array.from(value);
  return points.length <= maximum ? value : `${points.slice(0, maximum).join('')}…`;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'file') parts.push('[file]');
  }
  return parts.join('\n').trim();
}

export function visibleTextFromContent(content) {
  return textFromContent(content);
}

export function allowError(error) {
  if (error === null || typeof error !== 'object') return null;
  const allowed = {};
  for (const key of ['name', 'code', 'reason', 'message', 'status']) {
    const value = error[key];
    if (typeof value === 'string') allowed[key] = truncate(value, 1000);
    else if (typeof value === 'number' && Number.isFinite(value)) allowed[key] = value;
  }
  return Object.keys(allowed).length === 0 ? null : allowed;
}

function allowCancelReason(reason) {
  if (reason === null || typeof reason !== 'object') return null;
  if (typeof reason.kind !== 'string') return null;
  return {
    kind: reason.kind,
    ...(typeof reason.reason === 'string' ? { reason: truncate(reason.reason, 500) } : {}),
  };
}

function visibleTurnReason(reason) {
  if (reason === null || typeof reason !== 'object' || typeof reason.kind !== 'string') return { kind: 'unknown' };
  const kind = reason.kind;
  if (kind === 'error') return { kind, error: allowError(reason.error) };
  if (kind === 'aborted') return { kind, reason: allowCancelReason(reason.reason) };
  return { kind };
}

function visibleEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.seq !== 'number' || typeof event.type !== 'string') return null;
  const data = event.data;
  const base = { seq: event.seq, time: typeof event.time === 'number' ? event.time : null };
  switch (event.type) {
    case 'user/message': {
      // Only `kind: "user"` marks controller/user input. The host also appends
      // runtime-context snapshots and skill catalogs as user-role messages;
      // source metadata, not text, separates them, so unknown sources fail
      // closed instead of exposing internal scaffolding.
      const source = data?.source;
      if (source === null || typeof source !== 'object' || source.kind !== 'user') return null;
      const text = textFromContent(data?.content);
      return {
        ...base,
        type: 'user_message',
        text: text || '[empty user message]',
        meta: {
          sourceKind: 'user',
          ...(typeof source.rpcId === 'string' ? { requestId: source.rpcId } : {}),
        },
      };
    }
    case 'assistant/message': {
      const text = textFromContent(data?.message?.content);
      // A settlement with only reasoning/tool-call blocks has nothing public;
      // the separate tool_call items already represent those calls.
      if (text.length === 0) return null;
      return {
        ...base,
        type: 'assistant_message',
        text,
        meta: {
          turn: data?.turn ?? null,
          step: data?.step ?? null,
          ...(data?.interrupted === true ? { interrupted: true } : {}),
        },
      };
    }
    case 'tool/call':
      return {
        ...base,
        type: 'tool_call',
        text: `Tool call: ${typeof data?.name === 'string' ? data.name : 'unknown'}`,
        meta: {
          toolCallId: typeof data?.callId === 'string' ? data.callId : null,
          name: typeof data?.name === 'string' ? data.name : null,
        },
      };
    case 'tool/result': {
      const text = textFromContent(data?.message?.content);
      const error = allowError(data?.error);
      const isError = data?.message?.isError === true || error !== null;
      return {
        ...base,
        type: 'tool_result',
        text: text || (isError ? '[tool error without text]' : '[tool result without text]'),
        meta: {
          toolCallId: typeof data?.message?.toolCallId === 'string' ? data.message.toolCallId : null,
          isError,
          ...(error === null ? {} : { error }),
        },
      };
    }
    case 'turn/start':
      return {
        ...base,
        type: 'turn_start',
        text: `Turn ${String(data?.turn ?? '?')} started.`,
        meta: { turn: data?.turn ?? null },
      };
    case 'turn/end': {
      const reason = visibleTurnReason(data?.reason);
      const suffix = reason.kind === 'error' && reason.error?.message
        ? `: ${reason.error.message}`
        : reason.kind === 'aborted' && reason.reason?.kind
          ? ` (${reason.reason.kind})`
          : '';
      return {
        ...base,
        type: 'turn_end',
        text: `Turn ${String(data?.turn ?? '?')} ended: ${reason.kind}${suffix}`,
        meta: { turn: data?.turn ?? null, reason },
      };
    }
    case 'approval/asked':
      return {
        ...base,
        type: 'approval_request',
        text: `Approval requested${typeof data?.toolName === 'string' ? ` for ${data.toolName}` : ''}${typeof data?.reason === 'string' ? `: ${truncate(data.reason, 500)}` : ''}`,
        meta: {
          approvalId: typeof data?.id === 'string' ? data.id : null,
          toolName: typeof data?.toolName === 'string' ? data.toolName : null,
          callId: typeof data?.callId === 'string' ? data.callId : null,
        },
      };
    case 'approval/decided':
      return {
        ...base,
        type: 'approval_decision',
        text: `Approval ${typeof data?.id === 'string' ? data.id : '?'} decided: ${typeof data?.outcome === 'string' ? data.outcome : 'unknown'}`,
        meta: {
          approvalId: typeof data?.id === 'string' ? data.id : null,
          outcome: typeof data?.outcome === 'string' ? data.outcome : null,
        },
      };
    default:
      return null;
  }
}

export function normalizeVisibleEvents(events) {
  const items = [];
  for (const event of events) {
    const item = visibleEvent(event);
    if (item !== null) items.push(item);
  }
  items.sort((left, right) => left.seq - right.seq);
  return items;
}

function latestRequestHeader(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    if (config === null || typeof config !== 'object') continue;
    return {
      seq: event.seq,
      provider: typeof config.provider === 'string' ? config.provider : null,
      model: typeof config.model === 'string' ? config.model : null,
      reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
    };
  }
  return null;
}

function routeMatches(route) {
  return route !== null && typeof route === 'object'
    && route.provider === REQUIRED_PROVIDER
    && route.model === REQUIRED_MODEL
    && route.reasoningEffort === REQUIRED_REASONING;
}

export function modelRouteView(events, projections) {
  const selection = projections?.values?.modelSelection;
  const lastUsed = selection && typeof selection.lastUsed === 'object' ? selection.lastUsed : null;
  const next = selection && typeof selection.next === 'object' ? selection.next : null;
  const actual = latestRequestHeader(events);
  const basis = actual !== null ? 'request-header' : lastUsed !== null ? 'last-used' : next !== null ? 'next' : 'unknown';
  const effective = actual ?? lastUsed ?? next;
  return {
    actual,
    lastUsed,
    next,
    required: {
      provider: REQUIRED_PROVIDER,
      model: REQUIRED_MODEL,
      reasoningEffort: REQUIRED_REASONING,
    },
    basis,
    matchesRequired: routeMatches(effective),
    unknown: effective === null,
  };
}

export function admissionRoute(events, projections, defaultSelection) {
  const projection = projections?.values?.modelSelection;
  const next = projection && typeof projection.next === 'object' ? projection.next : null;
  const lastUsed = projection && typeof projection.lastUsed === 'object' ? projection.lastUsed : null;
  const actual = latestRequestHeader(events);
  const configured = defaultSelection && typeof defaultSelection === 'object'
    ? {
      provider: typeof defaultSelection.provider === 'string' ? defaultSelection.provider : null,
      model: typeof defaultSelection.model === 'string' ? defaultSelection.model : null,
      reasoningEffort: typeof defaultSelection.reasoningEffort === 'string' ? defaultSelection.reasoningEffort : null,
    }
    : null;
  const hasTerminal = events.some((event) => event?.type === 'turn/end');
  const hasExplicitSelection = events.some((event) => event?.type === 'model/selection');
  if (next !== null) return { ...next, source: 'next' };
  if (lastUsed !== null) return { ...lastUsed, source: 'last-used' };
  if (actual !== null) return { ...actual, source: 'request-header' };
  if (!hasTerminal && !hasExplicitSelection && configured !== null) return { ...configured, source: 'configured-default' };
  return { provider: null, model: null, reasoningEffort: null, source: 'unknown' };
}

export function routeAllowed(route) {
  return routeMatches(route);
}

function pendingApprovals(events) {
  const decided = new Set();
  for (const event of events) {
    if (event?.type === 'approval/decided' && typeof event.data?.id === 'string') decided.add(event.data.id);
  }
  const pending = [];
  for (const event of events) {
    if (event?.type !== 'approval/asked' || typeof event.data?.id !== 'string' || decided.has(event.data.id)) continue;
    pending.push({
      approvalId: event.data.id,
      toolName: typeof event.data.toolName === 'string' ? event.data.toolName : null,
      callId: typeof event.data.callId === 'string' ? event.data.callId : null,
      reason: typeof event.data.reason === 'string' ? truncate(event.data.reason, 500) : null,
    });
  }
  return pending;
}

function questionText(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, 10).map((question) => ({
    id: typeof question?.id === 'string' ? question.id : null,
    question: truncate(typeof question?.question === 'string' ? question.question : '', 500),
    header: truncate(typeof question?.header === 'string' ? question.header : null, 200),
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 10).map((option) => ({
        label: truncate(typeof option?.label === 'string' ? option.label : '', 200),
        ...(typeof option?.description === 'string' ? { description: truncate(option.description, 300) } : {}),
      }))
      : [],
  }));
}

function parseQuestionArguments(value) {
  if (value !== null && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Conservative legacy reflection: only an unresolved ask_user_question call
 * inside the currently open turn is reported. A completed/aborted turn or a
 * matching tool/result removes it. The structured projection stays preferred.
 */
function legacyQuestionSummary(events) {
  let lastStart = null;
  let lastEnd = null;
  for (const event of events) {
    if (event?.type === 'turn/start') lastStart = event;
    else if (event?.type === 'turn/end') lastEnd = event;
  }
  if (lastStart === null || (lastEnd !== null && lastEnd.seq > lastStart.seq)) return [];
  const resolved = new Set();
  for (const event of events) {
    if (event?.type !== 'tool/result') continue;
    const id = event.data?.message?.toolCallId ?? event.data?.toolCallId;
    if (typeof id === 'string') resolved.add(id);
  }
  const active = [];
  for (const event of events) {
    if (event?.seq <= lastStart.seq || event?.type !== 'tool/call') continue;
    if (event.data?.name !== 'ask_user_question' || typeof event.data?.callId !== 'string') continue;
    if (resolved.has(event.data.callId)) continue;
    const args = parseQuestionArguments(event.data?.arguments);
    active.push({
      callId: event.data.callId,
      state: 'open',
      source: 'legacy-tool-call',
      inferred: true,
      questionParse: args === null ? 'unavailable' : 'parsed',
      questions: args === null ? [] : questionText(args.questions),
    });
    if (active.length >= 10) break;
  }
  return active;
}

function questionSummary(projections, events) {
  const state = projections?.values?.userQuestions;
  const timed = state !== null && typeof state === 'object' && Array.isArray(state.active)
    ? state.active.slice(0, 10).map((entry) => ({
      callId: typeof entry?.callId === 'string' ? entry.callId : null,
      state: typeof entry?.state === 'string' ? entry.state : null,
      source: 'timed-projection',
      questions: questionText(entry?.questions),
    }))
    : [];
  const timedIds = new Set(timed.map((entry) => entry.callId).filter((id) => typeof id === 'string'));
  const inferred = legacyQuestionSummary(events).filter((entry) => !timedIds.has(entry.callId));
  return {
    known: true,
    active: [...timed, ...inferred].slice(0, 10),
  };
}

function inboxSummary(projections) {
  const inbox = projections?.values?.inbox;
  if (inbox === null || typeof inbox !== 'object' || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) {
    return { known: false, nextTurnCount: 0, nextStepCount: 0, items: [] };
  }
  const items = [];
  for (const [target, list] of [['next-turn', inbox['next-turn']], ['next-step', inbox['next-step']]]) {
    for (const message of list.slice(0, 10)) {
      items.push({
        target,
        text: truncate(textFromContent(message?.content) || '[untextual input]', 500),
      });
    }
  }
  return {
    known: true,
    nextTurnCount: inbox['next-turn'].length,
    nextStepCount: inbox['next-step'].length,
    items: items.slice(0, 20),
  };
}

function statusView(events, agent) {
  let lastStart = null;
  let lastEnd = null;
  for (const event of events) {
    if (event?.type === 'turn/start') lastStart = event;
    else if (event?.type === 'turn/end') lastEnd = event;
  }
  const running = agent?.status === 'running';
  if (running) {
    return {
      state: 'running',
      running: true,
      completion: null,
      note: 'A turn is currently running; admission is not completion.',
    };
  }
  if (lastEnd !== null && (lastStart === null || lastEnd.seq > lastStart.seq)) {
    const reason = visibleTurnReason(lastEnd.data?.reason);
    if (reason.kind === 'completed') return { state: 'finished', running: false, success: true, completion: { seq: lastEnd.seq, reason } };
    if (reason.kind === 'error') return { state: 'failed', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
    if (reason.kind === 'aborted') return { state: 'canceled', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
    if (reason.kind === 'blocked') return { state: 'blocked', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
    if (reason.kind === 'max-tokens') return { state: 'finished', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
    if (reason.kind === 'interrupted') return { state: 'unknown', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
    if (reason.kind === 'forked') return { state: 'canceled', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
    return { state: 'unknown', running: false, success: false, completion: { seq: lastEnd.seq, reason } };
  }
  if (lastStart !== null) {
    return {
      state: 'unknown',
      running: false,
      success: false,
      completion: null,
      note: 'A turn started without a durable terminal event; idle status alone is not success.',
    };
  }
  if (events.length === 0) {
    return { state: 'unknown', running: false, success: false, completion: null, note: 'No durable events yet.' };
  }
  return {
    state: 'unknown',
    running: false,
    success: false,
    completion: null,
    note: 'No durable completed/error/aborted turn evidence; idle alone is not success.',
  };
}

function nextVisible(normalized, cursor) {
  for (const item of normalized) {
    if (item.seq < cursor.seq) continue;
    if (item.seq > cursor.seq) return true;
    if (Array.from(item.text).length > cursor.offset) return true;
  }
  return false;
}

export function buildTaskView(input) {
  const {
    events,
    projections,
    agent,
    transientErrors = [],
    cursor: rawCursor,
    maxEvents = DEFAULT_GET_MAX_EVENTS,
    maxChars = DEFAULT_GET_MAX_CHARS,
  } = input;
  const cursor = normalizeCursor(rawCursor);
  const boundedEvents = Math.min(MAX_GET_MAX_EVENTS, Math.max(1, Number.isInteger(maxEvents) ? maxEvents : DEFAULT_GET_MAX_EVENTS));
  const boundedChars = Math.min(MAX_GET_MAX_CHARS, Math.max(1, Number.isInteger(maxChars) ? maxChars : DEFAULT_GET_MAX_CHARS));
  const normalized = normalizeVisibleEvents(events);
  const latestSeq = events.length === 0 ? -1 : events[events.length - 1].seq;
  const items = [];
  let next = { seq: cursor.seq, offset: cursor.offset };
  let usedChars = 0;
  let stopped = false;

  for (const item of normalized) {
    if (items.length >= boundedEvents || usedChars >= boundedChars) {
      stopped = true;
      break;
    }
    if (item.seq < cursor.seq) continue;
    const offset = item.seq === cursor.seq ? cursor.offset : 0;
    const points = Array.from(item.text);
    if (offset > points.length) continue;
    const start = { seq: item.seq, offset };
    const remaining = points.slice(offset).join('');
    if (remaining.length === 0) {
      items.push({ ...item, text: '', __start: start });
      next = { seq: item.seq + 1, offset: 0 };
      continue;
    }
    const budget = boundedChars - usedChars;
    if (budget <= 0) {
      stopped = true;
      break;
    }
    const slice = codePointSlice(item.text, offset, budget);
    const partial = slice.remaining;
    items.push({ ...item, text: slice.text, ...(partial ? { partial: true } : {}), __start: start });
    usedChars += Array.from(slice.text).length;
    if (partial) {
      next = { seq: item.seq, offset: slice.nextOffset };
      stopped = true;
      break;
    }
    next = { seq: item.seq + 1, offset: 0 };
  }

  // Enforce a serialized ceiling without dropping an unseen suffix silently.
  // Metadata and JSON escaping count. Prefer dropping whole trailing items,
  // but when only one item remains, shrink its text slice so a hasMore page
  // always makes cursor progress. If even zero-width metadata cannot fit,
  // fail structured rather than loop or silently skip text.
  const publicItemsOf = (list) => list.map(({ __start, ...item }) => item);
  const serializedLength = (list) => JSON.stringify(publicItemsOf(list)).length;
  while (items.length > 1 && serializedLength(items) > MAX_OUTPUT_CHARS) {
    const removed = items.pop();
    next = removed.__start;
    stopped = true;
  }
  if (items.length === 1 && serializedLength(items) > MAX_OUTPUT_CHARS) {
    const only = items[0];
    const points = Array.from(only.text);
    const start = only.__start;
    let low = 0;
    let high = points.length;
    let keep = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = [{ ...only, text: points.slice(0, middle).join(''), partial: true }];
      if (serializedLength(candidate) <= MAX_OUTPUT_CHARS) {
        keep = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (keep === 0) {
      throw Object.assign(new Error('output item metadata alone exceeds the serialized ceiling'), {
        code: 'output_metadata_too_large',
      });
    }
    if (keep < points.length) {
      only.text = points.slice(0, keep).join('');
      only.partial = true;
      next = { seq: only.seq, offset: start.offset + keep };
      stopped = true;
    }
  }
  const publicItems = publicItemsOf(items);

  const hasMore = stopped || nextVisible(normalized, next);
  if (items.length === 0 && !hasMore && next.seq === cursor.seq) {
    next = { seq: latestSeq + 1, offset: 0 };
  }
  const status = statusView(events, agent);
  const route = modelRouteView(events, projections);
  const approvals = pendingApprovals(events);
  const questions = questionSummary(projections, events);
  const inbox = inboxSummary(projections);
  const durableError = status.completion?.reason?.kind === 'error'
    ? { source: 'turn-end', seq: status.completion.seq, error: status.completion.reason.error }
    : null;
  let lastTurnStart = null;
  let lastTurnEnd = null;
  for (const event of events) {
    if (event?.type === 'turn/start') lastTurnStart = event;
    else if (event?.type === 'turn/end') lastTurnEnd = event;
  }
  let transientAnchor = null;
  let transientAnchorKind = 'none';
  if (lastTurnStart !== null && (lastTurnEnd === null || lastTurnStart.seq > lastTurnEnd.seq)) {
    transientAnchor = lastTurnStart.seq;
    transientAnchorKind = 'current-turn-start';
  } else if (lastTurnEnd !== null) {
    transientAnchor = lastTurnEnd.seq;
    transientAnchorKind = 'latest-turn-end';
  } else if (status.completion !== null) {
    transientAnchor = status.completion.seq;
    transientAnchorKind = 'terminal';
  }
  const currentTransient = [];
  const historicalTransient = [];
  for (const entry of transientErrors) {
    if (transientAnchor !== null && typeof entry.seq === 'number' && entry.seq <= transientAnchor) {
      historicalTransient.push({
        source: 'transient',
        historical: true,
        ...entry,
        anchor: { kind: transientAnchorKind, seq: transientAnchor },
      });
    } else {
      currentTransient.push({
        source: 'transient',
        ...entry,
        ...(transientAnchor === null || typeof entry.seq !== 'number' ? { turnContext: 'unknown' } : {}),
      });
    }
  }
  const errors = [
    ...(durableError === null ? [] : [durableError]),
    ...currentTransient,
  ];
  const historicalErrors = historicalTransient;
  const pendingAction = {
    pending: questions.active.length > 0 || approvals.length > 0 || projections?.values?.plan?.pending === true,
    questions,
    approvals,
    planPending: projections?.values?.plan?.pending === true,
  };

  return {
    items: publicItems,
    cursor: next,
    hasMore,
    partial: hasMore,
    latestSeq,
    status,
    modelRoute: route,
    pendingAction,
    pendingInbox: inbox,
    errors,
    historicalErrors,
  };
}
