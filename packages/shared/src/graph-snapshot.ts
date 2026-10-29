import { z } from 'zod'
import { graphLinkSchema, graphNodeSchema, pluginTypeSchema } from './domain'

const vectorSchema = z.object({ x: z.number(), y: z.number(), z: z.number() })

export const graphSnapshotViewSchema = z.object({
  camera: z
    .object({
      position: vectorSchema,
      lookAt: vectorSchema,
    })
    .nullable(),
  visibleTypes: z.array(pluginTypeSchema),
  focusOnly: z.boolean(),
  selectedNodeId: z.string().min(1).nullable(),
})
export type GraphSnapshotView = z.infer<typeof graphSnapshotViewSchema>

export const graphSnapshotExportSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  nodes: z.array(graphNodeSchema),
  links: z.array(graphLinkSchema),
  view: graphSnapshotViewSchema,
})
export type GraphSnapshotExport = z.infer<typeof graphSnapshotExportSchema>

export function buildGraphSnapshotExport(
  nodes: readonly z.infer<typeof graphNodeSchema>[],
  links: readonly z.infer<typeof graphLinkSchema>[],
  view: GraphSnapshotView,
  exportedAt = Date.now(),
): GraphSnapshotExport {
  return graphSnapshotExportSchema.parse({
    schemaVersion: 1,
    exportedAt,
    nodes: [...nodes].sort((left, right) => left.id.localeCompare(right.id)),
    links: [...links].sort((left, right) => left.id.localeCompare(right.id)),
    view: {
      ...view,
      visibleTypes: [...view.visibleTypes].sort(),
    },
  })
}

export function sanitizeGraphSnapshot(snapshot: GraphSnapshotExport): GraphSnapshotExport {
  return graphSnapshotExportSchema.parse({
    ...snapshot,
    nodes: snapshot.nodes.map(({ id, label, type, status, moduleName }) => ({
      id,
      label,
      type,
      status,
      ...(moduleName === undefined ? {} : { moduleName }),
    })),
    links: snapshot.links.map(({ id, source, target, type }) => ({ id, source, target, type })),
  })
}

export function serializeGraphSnapshotJson(snapshot: GraphSnapshotExport): string {
  return `${JSON.stringify(sanitizeGraphSnapshot(snapshot), null, 2)}\n`
}
