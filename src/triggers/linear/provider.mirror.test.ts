import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { Database, LinearConnectionRecord } from "../../db/types.js";
import { createPostgresTestRuntime } from "../../db/test-utils/runtime.js";
import { HubExecutionAgentStreamEventSchema } from "../../hub/protocol.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import {
  createLinearTriggerProvider,
  type LinearOutputContext,
  type LinearTriggerContext,
} from "./provider.js";
import { createLinearReplyReporter } from "./reporting.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  database: Database = createMemoryDatabase(),
  storage = { organizationId: "org", projectId: "project", revisionId: "revision" },
) {
  const context: LinearOutputContext = {
    provider: "linear",
    linearOrganizationId: "linear-org",
    issueId: "issue",
    agentSessionId: "session",
    turnKey: "input-1",
    publishIssueComment: true,
    threadRootCommentId: null,
  };
  const triggerContext: LinearTriggerContext = {
    provider: "linear",
    target: context,
    event: {
      linear: {
        event_type: "agent_session",
        action: "created",
        delivery_id: "delivery",
        connection_id: "connection",
        organization: { id: "linear-org" },
        actor: null,
        issue: {
          id: "issue",
          title: "Task",
          description: null,
          project: null,
          team: { id: "team" },
          state: null,
          assignee: null,
          label_ids: [],
          delegate: { id: "agent" },
        },
        comment: null,
        agent_session: { id: "session", app_user_id: "agent", status: "active" },
        agent_activity: null,
        prompt_context: null,
        trigger_thread_context: { status: "embedded" },
      },
    },
  };
  const execution = await database.insertAgentExecution({
    id: randomUUID(),
    organizationId: storage.organizationId,
    projectId: storage.projectId,
    machineId: null,
    triggerContext,
    outputContext: context,
    configurationRevisionId: storage.revisionId,
  });
  const connection: LinearConnectionRecord = {
    id: "connection",
    organizationId: storage.organizationId,
    slug: "linear",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Workspace",
    appUserId: "agent",
    accessToken: "test",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: ["read", "write"],
  };
  vi.spyOn(database, "findLinearConnectionForOrganization").mockResolvedValue(connection);
  const activities: Array<Parameters<LinearApiClient["createAgentActivity"]>[0]> = [];
  const comments = new Map<string, { id: string; issueId: string; body: string; parentId: null }>();
  const client: LinearApiClient = {
    readIssue: async () => undefined,
    readIssueComments: async () => ({ complete: true, comments: [] }),
    readAgentSessionActivities: async () => ({ complete: true, activities: [] }),
    readCommentThread: async () => undefined,
    readPublishedComment: async ({ id }) => comments.get(id),
    readPublishedAgentActivity: async ({ id }) => {
      const activity = activities.find((item) => item.id === id);
      return activity === undefined
        ? undefined
        : {
            id,
            agentSessionId: activity.agentSessionId,
            type: activity.content.type,
            body: activity.content.type === "action" ? "" : activity.content.body,
          };
    },
    createComment: async (input) => {
      assert.ok(input.id);
      comments.set(input.id, {
        id: input.id,
        issueId: input.issueId,
        body: input.body,
        parentId: null,
      });
    },
    createAgentActivity: async (input) => {
      activities.push(input);
    },
    updateAgentSessionExternalUrls: async () => {},
    updateAgentSessionPlan: async () => {},
    createAgentSessionOnComment: async () => ({ id: "unused" }),
  };
  const provider = createLinearTriggerProvider({
    configurationStoreForProject: () => {
      throw new Error("unused");
    },
    database,
    client,
  });
  await provider.onDispatchAccepted?.(triggerContext, context);
  activities.length = 0;
  const reporter = createLinearReplyReporter({ database, client });
  const reply = () =>
    reporter.publish({
      executionId: execution.id,
      context,
      body: "Work completed and verified",
      activity: { content: { type: "response", body: "Work completed and verified" } },
    });
  const stream = (item: Record<string, unknown>, target = context, trigger = triggerContext) =>
    provider.onAgentStreamEvent!(
      trigger,
      target,
      HubExecutionAgentStreamEventSchema.parse({ type: "timeline", provider: "codex", item }),
      execution.id,
    );
  return {
    database,
    execution,
    context,
    triggerContext,
    client,
    provider,
    reporter,
    activities,
    reply,
    stream,
  };
}

describe("Linear mirror and durable final reports", () => {
  it("serializes mirror and reporter across independent PostgreSQL connections", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const runtimes: Array<Awaited<ReturnType<typeof createPostgresTestRuntime>>> = [];
    const release = deferred();
    try {
      const first = await createPostgresTestRuntime(postgres.getConnectionUri());
      runtimes.push(first);
      const second = await createPostgresTestRuntime(postgres.getConnectionUri());
      runtimes.push(second);
      const projectId = randomUUID();
      await first.runtime.query(
        "insert into organization (id,name,slug) values ('mirror-org','Mirror','mirror')",
      );
      await first.runtime.query(
        "insert into projects (id,organization_id,name,slug) values ($1,'mirror-org','Mirror','mirror')",
        [projectId],
      );
      const revision = await first.database.insertProjectConfigurationRevision({
        projectId,
        sourceKind: "manual",
        sourceEvidence: {},
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: "mirror-test",
      });
      const f = await fixture(first.database, {
        organizationId: "mirror-org",
        projectId,
        revisionId: revision.id,
      });
      second.database.findLinearConnectionForOrganization =
        first.database.findLinearConnectionForOrganization.bind(first.database);
      const reporter = createLinearReplyReporter({ database: second.database, client: f.client });
      const started = deferred();
      const commentCreated = deferred();
      const createActivity = f.client.createAgentActivity.bind(f.client);
      const createComment = f.client.createComment.bind(f.client);
      f.client.createAgentActivity = async (input) => {
        if (input.content.type === "thought") {
          started.resolve();
          await release.promise;
        }
        await createActivity(input);
      };
      f.client.createComment = async (input) => {
        await createComment(input);
        commentCreated.resolve();
      };
      const mirroring = f.stream({ type: "assistant_message", text: "Work in flight" });
      await started.promise;
      const publishing = reporter.publish({
        executionId: f.execution.id,
        context: f.context,
        body: "Complete",
        activity: { content: { type: "response", body: "Complete" } },
      });
      await commentCreated.promise;
      // Observe a real server-side lock waiter, not merely two promises in one process.
      await vi.waitFor(
        async () => {
          const waiting = await first.runtime.query<{ count: string }>(
            "select count(*)::text as count from pg_locks where locktype = 'advisory' and not granted",
          );
          assert.equal(waiting.rows[0]?.count, "1");
        },
        { timeout: 5000, interval: 25 },
      );
      // Root publication proceeds independently, but native response must wait for the thought.
      assert.equal(f.activities.length, 0);
      release.resolve();
      await Promise.all([mirroring, publishing]);
      await f.stream({ type: "assistant_message", text: "Late after the final report" });
      assert.deepEqual(
        f.activities.map((item) => item.content.type),
        ["thought", "response"],
      );
      assert.ok((await second.database.findLinearReply(f.execution.id, "initial"))?.completedAt);
    } finally {
      release.resolve();
      await Promise.all(runtimes.map((runtime) => runtime.runtime.close()));
      await postgres.stop();
    }
  }, 120_000);

  it("keeps the final response last when Codex wraps Hub calls in functions.exec", async () => {
    const f = await fixture();
    await f.stream({ type: "reasoning", messageId: "buffer", text: "Buffered before publication" });
    await f.reply();
    await f.database.recordAgentExecutionHubAcknowledgement(f.execution.id, {
      kind: "finish_execution",
      status: "completed",
      observedAt: new Date(),
    });
    await f.stream({
      type: "tool_call",
      callId: "wrapped",
      name: "functions.exec",
      status: "completed",
    });
    await f.stream({ type: "assistant_message", text: "I posted the final result." });
    await f.provider.onAgentStreamEvent!(
      f.triggerContext,
      f.context,
      { type: "turn_completed", provider: "codex" },
      f.execution.id,
    );
    assert.deepEqual(
      f.activities.map((item) => item.content.type),
      ["response"],
    );
  });

  it("silences a reserved report even while its first destination is still pending", async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    const createComment = f.client.createComment.bind(f.client);
    f.client.createComment = async (input) => {
      started.resolve();
      await release.promise;
      await createComment(input);
    };
    const publishing = f.reply();
    await started.promise;
    await f.stream({
      type: "assistant_message",
      text: "This must not escape the reserved final report",
    });
    release.resolve();
    await publishing;
    assert.deepEqual(
      f.activities.map((item) => item.content.type),
      ["response"],
    );
  });

  it("serializes a slow mirror mutation before the final native response", async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    const commentCreated = deferred();
    const createActivity = f.client.createAgentActivity.bind(f.client);
    const createComment = f.client.createComment.bind(f.client);
    f.client.createAgentActivity = async (input) => {
      if (input.content.type === "thought") {
        started.resolve();
        await release.promise;
      }
      await createActivity(input);
    };
    f.client.createComment = async (input) => {
      await createComment(input);
      commentCreated.resolve();
    };
    const mirroring = f.stream({ type: "assistant_message", text: "Checking the result" });
    await started.promise;
    const publishing = f.reply();
    await commentCreated.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = f.activities.map((item) => item.content.type);
    release.resolve();
    await Promise.all([mirroring, publishing]);
    assert.deepEqual(beforeRelease, []);
    assert.deepEqual(
      f.activities.map((item) => item.content.type),
      ["thought", "response"],
    );
  });

  it.each(["session", "new-session"])(
    "allows a new turn in %s but suppresses its old snapshot",
    async (sessionId) => {
      const f = await fixture();
      await f.reply();
      await f.stream({ type: "assistant_message", text: "Late old thought" });
      const next = { ...f.context, turnKey: "input-2", agentSessionId: sessionId };
      const trigger: LinearTriggerContext = {
        ...f.triggerContext,
        target: next,
        event: {
          linear: {
            ...f.triggerContext.event.linear,
            action: "prompted",
            agent_session: { id: sessionId, app_user_id: "agent", status: "active" },
          },
        },
      };
      const opened = await f.database.beginAgentExecutionTurn(
        f.execution.id,
        new Date(),
        "input-2",
        {
          triggerContext: trigger,
          outputContext: next,
        },
      );
      assert.ok(opened);
      // The execution retains its initial dispatch key; the incoming trigger owns the new turn.
      const nextOutput = { ...next, turnKey: "input-1" };
      assert.deepEqual(opened.outputContext, nextOutput);
      await f.provider.onDispatchAccepted?.(trigger, next);
      f.activities.length = 0;
      await f.stream({
        type: "assistant_message",
        text: "Old context must not close the new mirror",
      });
      await f.stream(
        { type: "assistant_message", text: "Working on the new input" },
        nextOutput,
        trigger,
      );
      assert.deepEqual(
        f.activities.map((item) => [
          item.agentSessionId,
          item.content.type === "action" ? "" : item.content.body,
        ]),
        [[sessionId, "Working on the new input"]],
      );
    },
  );

  it("does not mirror with a replaced authorized connection", async () => {
    const f = await fixture();
    vi.spyOn(f.database, "findLinearConnectionForOrganization").mockResolvedValue(undefined);
    await f.stream({ type: "assistant_message", text: "No longer authorized" });
    assert.deepEqual(f.activities, []);
  });

  it.each(["database", "executionId"])("fails closed without durable %s", async (missing) => {
    const f = await fixture();
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("unused");
      },
      client: f.client,
      ...(missing === "database" ? {} : { database: f.database }),
    });
    await provider.onDispatchAccepted?.(f.triggerContext, f.context);
    f.activities.length = 0;
    await provider.onAgentStreamEvent?.(
      f.triggerContext,
      f.context,
      HubExecutionAgentStreamEventSchema.parse({
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "No durable authority available" },
      }),
      missing === "executionId" ? undefined : f.execution.id,
    );
    assert.deepEqual(f.activities, []);
  });

  it("discards a queued old batch without closing the replacement mirror", async () => {
    const f = await fixture();
    const locked = deferred();
    const release = deferred();
    const holding = f.database.withAdvisoryLock(`execution.prompt:${f.execution.id}`, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const queued = f.stream({ type: "assistant_message", text: "Old queued thought" });
    const next = { ...f.context, turnKey: "input-2" };
    const trigger = { ...f.triggerContext, target: next };
    // Simulate a new turn accepted while the old batch awaits its publication lock.
    await f.database.beginAgentExecutionTurn(f.execution.id, new Date(), "input-2", {
      triggerContext: trigger,
      outputContext: next,
    });
    await f.provider.onDispatchAccepted?.(trigger, next);
    f.activities.length = 0;
    release.resolve();
    await Promise.all([holding, queued]);
    await f.stream(
      { type: "assistant_message", text: "New turn is still open" },
      f.context,
      trigger,
    );
    assert.deepEqual(
      f.activities.map((item) => item.content.type),
      ["thought"],
    );
    assert.equal(
      f.activities[0]?.content.type === "thought" && f.activities[0].content.body,
      "New turn is still open",
    );
  });
});
