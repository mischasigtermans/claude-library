import { z } from 'zod';

export const OrgSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();

export const OrgArraySchema = z.array(OrgSchema);

export const ConversationSummarySchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    summary: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    model: z.string().nullish(),
    is_starred: z.boolean().optional(),
    project_uuid: z.string().nullish(),
    is_temporary: z.boolean().optional(),
    current_leaf_message_uuid: z.string().optional(),
    platform: z.string().optional(),
    session_id: z.string().nullish(),
    settings: z.record(z.unknown()).optional(),
    project: z
      .object({ uuid: z.string(), name: z.string() })
      .nullish(),
  })
  .passthrough();

const TextBlock = z
  .object({
    type: z.literal('text'),
    text: z.string().optional(),
    citations: z.array(z.record(z.unknown())).optional(),
    integration_name: z.string().optional(),
    start_timestamp: z.string().optional(),
    stop_timestamp: z.string().optional(),
  })
  .passthrough();

const ThinkingBlock = z
  .object({
    type: z.literal('thinking'),
    text: z.string().optional(),
    thinking: z.string().optional(),
  })
  .passthrough();

const ToolUseBlock = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    integration_name: z.string().optional(),
    start_timestamp: z.string().optional(),
    stop_timestamp: z.string().optional(),
  })
  .passthrough();

const ToolResultBlock = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().optional(),
    name: z.string().optional(),
    is_error: z.boolean().optional(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
      .optional(),
    integration_name: z.string().optional(),
    start_timestamp: z.string().optional(),
    stop_timestamp: z.string().optional(),
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
    url: z.string().optional(),
    primary_color: z.string().optional(),
    image_width: z.number().optional(),
    image_height: z.number().optional(),
  })
  .passthrough();

const MessageFileSchema = z
  .object({
    uuid: z.string(),
    file_uuid: z.string().optional(),
    file_kind: z.string().optional(),
    file_name: z.string().optional(),
    thumbnail_url: z.string().optional(),
    preview_url: z.string().optional(),
    thumbnail_asset: MessageFileAssetSchema.optional(),
    preview_asset: MessageFileAssetSchema.optional(),
    created_at: z.string().optional(),
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
      .optional(),
    sender: z.enum(['human', 'assistant']),
    index: z.number().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    parent_message_uuid: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
    files: z.array(MessageFileSchema).optional(),
    sync_sources: z.array(z.unknown()).optional(),
    truncated: z.boolean().optional(),
    input_mode: z.string().optional(),
    stop_reason: z.string().nullish(),
    compaction_summary: z.string().nullish(),
  })
  .passthrough();

export const ConversationFullSchema = ConversationSummarySchema.extend({
  chat_messages: z.array(MessageSchema),
}).passthrough();

export const ProjectSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    description: z.string().optional(),
    is_starred: z.boolean().optional(),
    is_starter_project: z.boolean().optional(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    archived_at: z.string().nullish(),
  })
  .passthrough();

export const ProjectArraySchema = z.array(ProjectSchema);

export const ProjectExtendedSchema = ProjectSchema.extend({
  prompt_template: z.string().optional(),
  is_harmony_project: z.boolean().optional(),
  docs_count: z.number().optional(),
  files_count: z.number().optional(),
}).passthrough();

export const ProjectFileSchema = z
  .object({
    uuid: z.string(),
    file_name: z.string().optional(),
  })
  .passthrough();

export const ProjectDocSchema = z
  .object({
    uuid: z.string(),
    file_name: z.string(),
    content: z.string(),
    project_uuid: z.string(),
    created_at: z.string(),
    estimated_token_count: z.number().optional(),
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
    snapshot_name: z.string().optional(),
    conversation_uuid: z.string().nullish(),
    project_uuid: z.string().nullish(),
    last_message_index: z.number().nullish(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
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
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectExtended = z.infer<typeof ProjectExtendedSchema>;
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;
export type OrganizationMemory = z.infer<typeof OrganizationMemorySchema>;
export type Share = z.infer<typeof ShareSchema>;
