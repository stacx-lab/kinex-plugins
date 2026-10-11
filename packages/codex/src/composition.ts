import type { KinexRuntime } from "@kinex/core"
import { coreContribution, type KinexContribution } from "@kinex/core/integration"
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from "@kinex/setup"

export interface KinexComposition {
  builtinSkillRoots?: readonly string[]
  reservedToolNames?: readonly string[]
  contributions(runtime: KinexRuntime): readonly KinexContribution[]
}

export const defaultComposition: KinexComposition = {
  builtinSkillRoots: setupSkillRoots,
  reservedToolNames: setupToolNames,
  contributions: runtime => [coreContribution(runtime), setupContribution(createKinexSetup(runtime))],
}
