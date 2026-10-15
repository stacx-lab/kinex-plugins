import type { KinexRuntime } from "@kinex/core"
import type { KinexContribution } from "@kinex/core/integration"

export interface KinexComposition {
  builtinSkillRoots?: readonly string[]
  reservedToolNames?: readonly string[]
  contributions(runtime: KinexRuntime): readonly KinexContribution[]
}
