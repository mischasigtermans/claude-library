import { z } from 'zod';

export const OrgSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    capabilities: z.array(z.string()).nullish(),
  })
  .passthrough();

export const OrgArraySchema = z.array(OrgSchema);

export const ConversationSummarySchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    summary: z.string().nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    model: z.string().nullish(),
    is_starred: z.boolean().nullish(),
    project_uuid: z.string().nullish(),
    is_temporary: z.boolean().nullish(),
    current_leaf_message_uuid: z.string().nullish(),
    platform: z.string().nullish(),
    session_id: z.string().nullish(),
    settings: z.record(z.unknown()).nullish(),
    project: z
      .object({ uuid: z.string(), name: z.string() })
      .nullish(),
  })
  .passthrough();

const CitationSourceSchema = z
  .object({
    uuid: z.string().nullish(),
    title: z.string().nullish(),
    url: z.string().nullish(),
    source: z.string().nullish(),
    icon_url: z.string().nullish(),
  })
  .passthrough();

const CitationMetadataSchema = z
  .object({
    type: z.string().nullish(),
    site_domain: z.string().nullish(),
    site_name: z.string().nullish(),
    favicon_url: z.string().nullish(),
  })
  .passthrough();

export const CitationSchema = z
  .object({
    uuid: z.string(),
    title: z.string().nullish(),
    url: z.string().nullish(),
    origin_tool_name: z.string().nullish(),
    start_index: z.number().nullish(),
    end_index: z.number().nullish(),
    metadata: CitationMetadataSchema.nullish(),
    sources: z.array(CitationSourceSchema).nullish(),
  })
  .passthrough();

const TextBlock = z
  .object({
    type: z.literal('text'),
    text: z.string().nullish(),
    citations: z.array(CitationSchema).nullish(),
    integration_name: z.string().nullish(),
    start_timestamp: z.string().nullish(),
    stop_timestamp: z.string().nullish(),
  })
  .passthrough();

const ThinkingBlock = z
  .object({
    type: z.literal('thinking'),
    text: z.string().nullish(),
    thinking: z.string().nullish(),
  })
  .passthrough();

const ToolUseBlock = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().nullish(),
    name: z.string().nullish(),
    input: z.unknown().nullish(),
    integration_name: z.string().nullish(),
    start_timestamp: z.string().nullish(),
    stop_timestamp: z.string().nullish(),
  })
  .passthrough();

const ToolResultBlock = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().nullish(),
    name: z.string().nullish(),
    is_error: z.boolean().nullish(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().nullish() }).passthrough())
      .nullish(),
    integration_name: z.string().nullish(),
    start_timestamp: z.string().nullish(),
    stop_timestamp: z.string().nullish(),
  })
  .passthrough();

export const BlockSchema = z.discriminatedUnion('type', [
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
]);

const MessageFileAssetSchema = z
  .object({
    url: z.string().nullish(),
    primary_color: z.string().nullish(),
    image_width: z.number().nullish(),
    image_height: z.number().nullish(),
  })
  .passthrough();

const MessageFileSchema = z
  .object({
    uuid: z.string(),
    file_uuid: z.string().nullish(),
    file_kind: z.string().nullish(),
    file_name: z.string().nullish(),
    thumbnail_url: z.string().nullish(),
    preview_url: z.string().nullish(),
    thumbnail_asset: MessageFileAssetSchema.nullish(),
    preview_asset: MessageFileAssetSchema.nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

const MessageSchema = z
  .object({
    uuid: z.string(),
    text: z.string(),
    content: z
      .array(
        z.union([
          BlockSchema,
          z.object({ type: z.string() }).passthrough(),
        ]),
      )
      .nullish(),
    sender: z.enum(['human', 'assistant']),
    index: z.number().nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    parent_message_uuid: z.string().nullish(),
    attachments: z.array(z.unknown()).nullish(),
    files: z.array(MessageFileSchema).nullish(),
    sync_sources: z.array(z.unknown()).nullish(),
    truncated: z.boolean().nullish(),
    input_mode: z.string().nullish(),
    stop_reason: z.string().nullish(),
    compaction_summary: z.unknown().nullish(),
  })
  .passthrough();

export const ConversationFullSchema = ConversationSummarySchema.extend({
  chat_messages: z.array(MessageSchema),
}).passthrough();

export const ProjectSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    is_starred: z.boolean().nullish(),
    is_starter_project: z.boolean().nullish(),
    created_at: z.string(),
    updated_at: z.string().nullish(),
    archived_at: z.string().nullish(),
  })
  .passthrough();

export const ProjectArraySchema = z.array(ProjectSchema);

export const ProjectExtendedSchema = ProjectSchema.extend({
  prompt_template: z.string().nullish(),
  is_harmony_project: z.boolean().nullish(),
  docs_count: z.number().nullish(),
  files_count: z.number().nullish(),
}).passthrough();

export const ProjectFileSchema = z
  .object({
    uuid: z.string(),
    file_name: z.string().nullish(),
  })
  .passthrough();

export const ProjectDocSchema = z
  .object({
    uuid: z.string(),
    file_name: z.string(),
    content: z.string(),
    project_uuid: z.string(),
    created_at: z.string(),
    estimated_token_count: z.number().nullish(),
  })
  .passthrough();

export const ProjectDocArraySchema = z.array(ProjectDocSchema);

export const OrganizationMemorySchema = z
  .object({
    memory: z.string(),
    controls: z.unknown(),
    updated_at: z.string(),
  })
  .passthrough();

export const ShareSchema = z
  .object({
    uuid: z.string(),
    snapshot_name: z.string().nullish(),
    conversation_uuid: z.string().nullish(),
    project_uuid: z.string().nullish(),
    last_message_index: z.number().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();

export const ShareArraySchema = z.array(ShareSchema);

export { MessageSchema, MessageFileSchema };

export type Org = z.infer<typeof OrgSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationFull = z.infer<typeof ConversationFullSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageFile = z.infer<typeof MessageFileSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectExtended = z.infer<typeof ProjectExtendedSchema>;
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;
export type OrganizationMemory = z.infer<typeof OrganizationMemorySchema>;
export type Share = z.infer<typeof ShareSchema>;
