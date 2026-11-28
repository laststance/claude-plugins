// Types of outputs.mjs, for the hooks module and the tests (the module itself is plain JavaScript the node worker runs).

/**
 * How an Output block is coloured: the Language of the whole block, the Output shapes its lines may have, and the
 * files the command gave `wc` (`counted`, with the number of counts each one's row holds in `columns`) and a grep
 * (`grepped`), as written. A plan without the lists (one an older hooks module sent the worker) names no files.
 */
export type OutputPlan = { language: string | null; shapes: string[]; counted?: string[]; columns?: number[]; grepped?: string[] }

export const SHAPE_IDS: string[]
export const BLOCK: 'block'
export function shapeScope(id: string): string
export function shapeGrammars(): Record<string, { scopeName: string; patterns: unknown[] }>
export function planOutput(command: string, output: string): OutputPlan
export function assignLines(lines: string[], plan: OutputPlan): (string | null)[]
export function hasColour(lines: string[], plan: OutputPlan): boolean
export function readsApart(command: string): boolean
export function countedNameAt(line: string, counted: Set<string>, columns?: Map<string, Set<number>>): number
export function columnsOf(plan: OutputPlan): Map<string, Set<number>>
