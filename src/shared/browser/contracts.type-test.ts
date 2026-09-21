import type {
  ActionOutcome,
  BrowserAction,
  BrowserActCommand,
  BrowserCaptureCommand,
  BrowserCaptureResult,
  BrowserClaimCommand,
  BrowserClaimResult,
  BrowserCloseCommand,
  BrowserCloseResult,
  BrowserListCommand,
  BrowserListResult,
  BrowserNavigateAction,
  BrowserNavigateCommand,
  BrowserNavigateResult,
  BrowserObserveCommand,
  BrowserObserveResult,
  BrowserOpenCommand,
  BrowserOpenResult,
  BrowserPageProjection,
  ObservationIdentity
} from './index'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false

type Assert<Condition extends true> = Condition
type IsAny<Value> = 0 extends 1 & Value ? true : false
type IsNotAny<Value> = Equal<IsAny<Value>, false>
type IsLooseUnknownRecord<Value> =
  Value extends Record<string, unknown>
    ? string extends keyof Value
      ? true
      : false
    : false

type ClickAction = Extract<BrowserAction, { kind: 'click' }>
type FillAction = Extract<BrowserAction, { kind: 'fill' }>
type ScrollAction = Extract<BrowserAction, { kind: 'scroll' }>
type UrlNavigate = Extract<BrowserNavigateAction, { kind: 'url' }>
type BackNavigate = Extract<BrowserNavigateAction, { kind: 'back' }>
type AppliedOutcome = Extract<ActionOutcome, { status: 'applied' }>
type NotAppliedOutcome = Extract<ActionOutcome, { status: 'not_applied' }>

type PublicContractsRemainExplicit = [
  Assert<IsNotAny<ObservationIdentity>>,
  Assert<IsNotAny<BrowserAction>>,
  Assert<IsNotAny<ActionOutcome>>,
  Assert<IsNotAny<BrowserPageProjection>>,
  Assert<IsNotAny<BrowserActCommand>>,
  Assert<IsNotAny<BrowserOpenCommand>>,
  Assert<IsNotAny<BrowserObserveCommand>>,
  Assert<IsNotAny<BrowserCaptureCommand>>,
  Assert<IsNotAny<BrowserCloseCommand>>,
  Assert<IsNotAny<BrowserClaimCommand>>,
  Assert<IsNotAny<BrowserNavigateCommand>>,
  Assert<IsNotAny<BrowserListCommand>>,
  Assert<IsNotAny<BrowserOpenResult>>,
  Assert<IsNotAny<BrowserNavigateResult>>,
  Assert<IsNotAny<BrowserObserveResult>>,
  Assert<IsNotAny<BrowserCaptureResult>>,
  Assert<IsNotAny<BrowserCloseResult>>,
  Assert<IsNotAny<BrowserListResult>>,
  Assert<IsNotAny<BrowserClaimResult>>,
  Assert<Equal<IsLooseUnknownRecord<BrowserAction>, false>>,
  Assert<Equal<IsLooseUnknownRecord<ActionOutcome>, false>>,
  Assert<Equal<IsLooseUnknownRecord<ObservationIdentity>, false>>,
  Assert<Equal<'text' extends keyof ClickAction ? true : false, false>>,
  Assert<Equal<'values' extends keyof ClickAction ? true : false, false>>,
  Assert<Equal<'ref' extends keyof ScrollAction ? true : false, false>>,
  Assert<Equal<'text' extends keyof FillAction ? true : false, true>>,
  Assert<Equal<'url' extends keyof BackNavigate ? true : false, false>>,
  Assert<Equal<'url' extends keyof UrlNavigate ? true : false, true>>,
  Assert<Equal<'observation' extends keyof AppliedOutcome ? true : false, true>>,
  Assert<Equal<'code' extends keyof AppliedOutcome ? true : false, false>>,
  Assert<Equal<'observation' extends keyof NotAppliedOutcome ? true : false, false>>,
  Assert<Equal<BrowserAction['kind'], 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'viewport'>>,
  Assert<Equal<BrowserNavigateAction['kind'], 'url' | 'back' | 'forward' | 'reload' | 'stop'>>,
  Assert<Equal<'faviconUrl' extends keyof BrowserPageProjection ? true : false, true>>,
  Assert<Equal<'loadError' extends keyof BrowserPageProjection ? true : false, true>>
]

export type BrowserContractTypeAssertions = PublicContractsRemainExplicit
