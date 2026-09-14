import { z } from "zod";
import type { AgentExecutionRecord, Database } from "../../db/types.js";
import { linearReplyTurnKey } from "../../db/linear-replies.js";
import type { LinearOutputContext, LinearTriggerContext } from "./provider.js";
import { matchingLinearReplyConnection } from "./reply-authority.js";

export type LinearMirrorStore = Pick<
  Database,
  | "withAdvisoryLock"
  | "findAgentExecutionById"
  | "findLinearReply"
  | "findLinearConnectionForOrganization"
>;

const MirrorTargetSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string(),
  issueId: z.string(),
  agentSessionId: z.string(),
  turnKey: z.string().optional(),
  publishIssueComment: z.literal(true),
});

const MirrorTriggerSchema = z.object({
  target: z.object({ turnKey: z.string().optional() }),
  event: z.object({
    linear: z.object({
      agent_session: z.object({ id: z.string(), app_user_id: z.string() }),
    }),
  }),
});

/**
 * Share the final reporter's native-publication lock. A thought already in flight finishes
 * before the response; a queued thought observes its reservation and never reopens the panel.
 * No daemon tool-name convention participates in this boundary.
 */
export async function deliverLinearMirrorBatch(input: {
  database?: Partial<LinearMirrorStore>;
  executionId?: string;
  triggerContext: LinearTriggerContext;
  outputContext: LinearOutputContext;
  isCurrent: () => boolean;
  publish: (expectedConnectionId?: string) => Promise<void>;
}): Promise<boolean> {
  if (!input.isCurrent()) return false;
  if (input.outputContext.publishIssueComment !== true) {
    await input.publish();
    return true;
  }
  const { database, executionId } = input;
  if (
    executionId === undefined ||
    database?.withAdvisoryLock === undefined ||
    database.findAgentExecutionById === undefined ||
    database.findLinearReply === undefined ||
    database.findLinearConnectionForOrganization === undefined
  )
    throw new Error("Durable Linear mirrors require execution and report storage");
  const store: LinearMirrorStore = {
    withAdvisoryLock: database.withAdvisoryLock.bind(database),
    findAgentExecutionById: database.findAgentExecutionById.bind(database),
    findLinearReply: database.findLinearReply.bind(database),
    findLinearConnectionForOrganization:
      database.findLinearConnectionForOrganization.bind(database),
  };
  return store.withAdvisoryLock(`execution.prompt:${executionId}`, async () => {
    if (!input.isCurrent()) return false;
    const connectionId = await currentMirrorConnection(store, executionId, input);
    if (connectionId === undefined) return false;
    await input.publish(connectionId);
    return true;
  });
}

async function currentMirrorConnection(
  database: LinearMirrorStore,
  executionId: string,
  input: Pick<Parameters<typeof deliverLinearMirrorBatch>[0], "triggerContext" | "outputContext">,
): Promise<string | undefined> {
  const execution = await database.findAgentExecutionById(executionId);
  if (execution === undefined || !["spawning", "running"].includes(execution.status))
    return undefined;
  if (!matchesCurrentMirror(execution, input)) return undefined;
  const target = input.outputContext;
  const connectionId = matchingLinearReplyConnection(input.triggerContext, target);
  if (
    connectionId === undefined ||
    matchingLinearReplyConnection(execution.triggerContext, target) !== connectionId
  )
    return undefined;
  const connection = await database.findLinearConnectionForOrganization(
    execution.organizationId,
    target.linearOrganizationId,
  );
  if (
    connection?.id !== connectionId ||
    input.triggerContext.event.linear.agent_session?.app_user_id !== connection.appUserId
  )
    return undefined;
  const reply = await database.findLinearReply(
    executionId,
    linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id),
  );
  if (reply !== undefined) return undefined;
  return connectionId;
}

function matchesCurrentMirror(
  execution: Pick<AgentExecutionRecord, "triggerContext" | "outputContext">,
  input: Pick<Parameters<typeof deliverLinearMirrorBatch>[0], "triggerContext" | "outputContext">,
): boolean {
  const current = MirrorTargetSchema.safeParse(execution.outputContext);
  const currentTrigger = MirrorTriggerSchema.safeParse(execution.triggerContext);
  const target = input.outputContext;
  if (
    !current.success ||
    !currentTrigger.success ||
    current.data.linearOrganizationId !== target.linearOrganizationId ||
    current.data.issueId !== target.issueId ||
    current.data.agentSessionId !== target.agentSessionId ||
    current.data.turnKey !== target.turnKey ||
    currentTrigger.data.target.turnKey !== input.triggerContext.target.turnKey ||
    currentTrigger.data.event.linear.agent_session.id !== target.agentSessionId ||
    currentTrigger.data.event.linear.agent_session.app_user_id !==
      input.triggerContext.event.linear.agent_session?.app_user_id
  )
    return false;
  return true;
}
