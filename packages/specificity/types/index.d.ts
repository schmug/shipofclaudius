// The specificity mod's state contract: every value it keeps in `$.state`.
// `claude plugin validate` holds each `$.state` key the hooks module names to
// this file, and the module imports its value types from here.

/** Each rubric dimension, 0-3, judged on what the prompt plus context pins down. */
export type SpecificityDimensions = {
  /** What and where: the file, function, option or thing acted on. */
  target: number
  /** Done-criteria: how anyone would know the work is finished. */
  outcome: number
  /** Constraints: what must not change, limits, style, tools. */
  constraints: number
  /** Scope: how far the change may reach. */
  scope: number
}

/** One scored prompt, as the judge answered it and the mod checked it. */
export type SpecificityResult = {
  /** 0-100. */
  score: number
  dimensions: SpecificityDimensions
  /** The single most valuable missing detail, at most 12 words, or null. */
  gap: string | null
  /** One sentence. */
  rationale: string
  /** Which judge produced it. */
  mode: 'haiku' | 'fork'
  /** The prompt's first 80 characters, so `/spec` can say which prompt it was. */
  excerpt: string
  /** When the score landed, ms since the epoch. */
  at: number
  /** How long the judge took, in ms. */
  ms: number
}

declare module 'claude-code' {
  interface PluginState {
    specificity: {
      /** The latest score, or null before the first one. */
      last: SpecificityResult | null
      /** Recent scores, oldest first, capped at 50. */
      history: number[]
      /** The newest prompt has no score to show (its judge failed, or the session ended mid-judge): no band until the next score lands. */
      isHidden: boolean
      /** The band is off until `/spec on` (`/spec off`). */
      isBandOff: boolean
      /** The person pressed Hide (`/spec hide`): the band is one short line with a Show button until Show or `/spec on`. */
      isCollapsed: boolean
    }
  }
}
