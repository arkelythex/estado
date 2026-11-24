import {
  fetchModerationCases,
  publishReport,
  rejectCase,
  runDemoIngest,
  triageCase,
  verifyCase,
  type IngestResult,
  type ModerationAction,
  type ModerationCase,
  type StatusFilter,
} from './admin-api'

export interface ScopeGuard {
  currentScope(): number
  invalidateScope(): number
  isScopeCurrent(scopeGen: number): boolean
  nextRequest(): { scopeGen: number; requestSeq: number }
  isRequestCurrent(scopeGen: number, requestSeq: number): boolean
}

export function createScopeGuard(): ScopeGuard {
  let scopeGen = 0
  let requestSeq = 0

  return {
    currentScope() {
      return scopeGen
    },
    invalidateScope() {
      scopeGen += 1
      requestSeq += 1
      return scopeGen
    },
    isScopeCurrent(candidateScopeGen: number) {
      return candidateScopeGen === scopeGen
    },
    nextRequest() {
      requestSeq += 1
      return { scopeGen, requestSeq }
    },
    isRequestCurrent(candidateScopeGen: number, candidateSeq: number) {
      return candidateScopeGen === scopeGen && candidateSeq === requestSeq
    },
  }
}

export async function loadScopedModerationQueue(
  guard: ScopeGuard,
  token: string,
  municipalityId: string,
  status: StatusFilter,
  fetchFn: typeof fetchModerationCases = fetchModerationCases,
): Promise<
  | { status: 'ok'; cases: ModerationCase[] }
  | { status: 'error'; error: unknown }
  | { status: 'stale' }
> {
  const { scopeGen, requestSeq } = guard.nextRequest()
  try {
    const cases = await fetchFn(token, { municipalityId, status })
    if (!guard.isRequestCurrent(scopeGen, requestSeq)) {
      return { status: 'stale' }
    }
    return { status: 'ok', cases }
  } catch (error: unknown) {
    if (!guard.isRequestCurrent(scopeGen, requestSeq)) {
      return { status: 'stale' }
    }
    return { status: 'error', error }
  }
}

export interface ScopedModerationActionParams {
  token: string
  municipalityId: string
  reportId: string
  action: ModerationAction
  reason: string
  publicText: string
}

export interface ModerationActionDeps {
  triage?: typeof triageCase
  verify?: typeof verifyCase
  reject?: typeof rejectCase
  publish?: typeof publishReport
}

export async function executeScopedModerationAction(
  guard: ScopeGuard,
  params: ScopedModerationActionParams,
  deps: ModerationActionDeps = {},
): Promise<{ status: 'applied' } | { status: 'stale' }> {
  const startScopeGen = guard.currentScope()
  const triageFn = deps.triage ?? triageCase
  const verifyFn = deps.verify ?? verifyCase
  const rejectFn = deps.reject ?? rejectCase
  const publishFn = deps.publish ?? publishReport

  if (params.action === 'TRIAGE') {
    await triageFn(params.token, params.reportId, {
      municipalityId: params.municipalityId,
      reason: params.reason,
    })
  } else if (params.action === 'VERIFY') {
    await verifyFn(params.token, params.reportId, {
      municipalityId: params.municipalityId,
      reason: params.reason,
    })
  } else if (params.action === 'REJECT') {
    await rejectFn(params.token, params.reportId, {
      municipalityId: params.municipalityId,
      reason: params.reason,
    })
  } else if (params.action === 'PUBLISH') {
    await publishFn(params.token, params.reportId, {
      municipalityId: params.municipalityId,
      reason: params.reason,
      publicText: params.publicText,
    })
  }

  if (!guard.isScopeCurrent(startScopeGen)) {
    return { status: 'stale' }
  }
  return { status: 'applied' }
}

export async function executeScopedDemoIngest(
  guard: ScopeGuard,
  token: string,
  municipalityId: string,
  ingestFn: typeof runDemoIngest = runDemoIngest,
): Promise<{ status: 'ok'; result: IngestResult } | { status: 'stale' }> {
  const startScopeGen = guard.currentScope()
  const result = await ingestFn(token, municipalityId)
  if (!guard.isScopeCurrent(startScopeGen)) {
    return { status: 'stale' }
  }
  return { status: 'ok', result }
}
