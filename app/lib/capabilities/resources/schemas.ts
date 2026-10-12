import { RemoveOptional, Type } from 'typebox';

export const CapabilityResourceReferenceSchema = Type.String({ minLength: 1, maxLength: 1000, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
const identity = Type.String({ minLength: 1, maxLength: 200, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
const nullableIdentity = Type.Union([identity, Type.Null()]);
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const metadata = Type.Object({
  displayName: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200, pattern: '^[^\\x00-\\x1f\\x7f]+$' }), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])),
  responsibleUserId: Type.Optional(nullableIdentity),
}, { additionalProperties: false });
const grant = Type.Object({
  targetType: Type.Union(['organization', 'role', 'workspace', 'project', 'user'].map(value => Type.Literal(value))),
  targetId: identity,
  canUse: Type.Boolean(), canEdit: Type.Boolean(), canManage: Type.Boolean(),
}, { additionalProperties: false });
const fields = {
  expectedMetadataRevision: revision,
  expectedGrantsRevision: revision,
  metadata: Type.Optional(metadata),
  grants: Type.Optional(Type.Array(grant, { maxItems: 100 })),
  accessMode: Type.Optional(Type.Union([Type.Literal('inherit'), Type.Literal('restricted')])),
};
export const CapabilityResourceMutationSchema = Type.Object(fields, { additionalProperties: false });
export const CapabilityResourceConfigurationSchema = Type.Object({
  ...fields,
  ownership: Type.Optional(Type.Union([
    Type.Object({ type: Type.Union([Type.Literal('user'), Type.Literal('organization')]) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal('team'), workspaceId: identity }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false });

export { metadata as CapabilityResourceMetadataPatchSchema, grant as CapabilityResourceGrantInputSchema };
export const CapabilityResourceOwnershipChoiceSchema = RemoveOptional(CapabilityResourceConfigurationSchema.properties.ownership);
