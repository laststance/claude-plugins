// Types of outputs.mjs, for the hooks module and the tests (the module itself is plain JavaScript the node worker runs).

/** How an Output block is coloured: the Language of the whole block, and the Output shapes its lines may have. */
export type OutputPlan = { language: string | null; shapes: string[] }

export const SHAPE_IDS: string[]
export const BLOCK: 'block'
export function shapeScope(id: string): string
export function shapeGrammars(): Record<string, { scopeName: string; patterns: unknown[] }>
export function planOutput(command: string, output: string): OutputPlan
export function assignLines(lines: string[], plan: OutputPlan): (string | null)[]
export function hasColour(lines: string[], plan: OutputPlan): boolean
