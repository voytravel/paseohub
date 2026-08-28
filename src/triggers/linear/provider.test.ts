import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearApiClient, LinearIssueCommentsResult } from "../../providers/linear/client.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { TriggerContextMaterialization } from "../index.js";
import { createLinearTriggerProvider, type LinearTriggerContext } from "./provider.js";

function materializerFor(api: LinearApiClient) {
  const provider = createLinearTriggerProvider({
    configurationStoreForProject: unusedStore,
    api,
  });
  if (provider.materializeContext === undefined) {
    throw new Error("Linear provider must materialize context");
  }
  const materialize = provider.materializeContext.bind(provider);
  return (input: TriggerContextMaterialization<LinearTriggerContext>) => materialize(input);
}

describe("Linear trigger context", () => {
  it("hydrates the issue comment thread and drops the triggering comment", async () => {
    const calls: { issueId: string; beforeCommentId?: string }[] = [];
    const materialize = materializerFor(
      apiReturning(
        {
          comments: [
            comment("older", "what should the button do?", "user-1"),
            comment("bot", "I added the button.", "app-1"),
            comment("trigger", "@paseo not like that", "user-1"),
          ],
          complete: true,
        },
        calls,
      ),
    );

    const materialized = await materialize(launch("trigger"));

    assert.equal(materialized.linear.issue_thread.status, "materialized");
    assert.deepEqual(
      materialized.linear.issue_thread.comments.map((entry) => entry.id),
      ["older", "bot", "trigger"],
    );
    // Dropping the triggering comment is the client's job; the provider only forwards its id,
    // and that contract is what this asserts.
    assert.deepEqual(calls, [{ issueId: "issue-1", beforeCommentId: "trigger" }]);
  });

  it("keeps the agent's own replies attributed so it recognizes its previous turn", async () => {
    const materialize = materializerFor(
      apiReturning(
        { comments: [comment("bot", "I added the button.", "app-1", "Paseo")], complete: true },
        [],
      ),
    );

    const materialized = await materialize(launch("trigger"));

    assert.deepEqual(materialized.linear.issue_thread.comments[0]?.author, {
      id: "app-1",
      name: "Paseo",
    });
  });

  it("degrades to an explicit unavailable thread when Linear cannot be read", async () => {
    const materialize = materializerFor({
      readIssue: async () => undefined,
      createComment: async () => undefined,
      readIssueComments: async () => {
        throw new Error("linear unreachable");
      },
    });

    const materialized = await materialize(launch("trigger"));

    assert.equal(materialized.linear.issue_thread.status, "unavailable");
    assert.deepEqual(materialized.linear.issue_thread.comments, []);
    assert.equal(materialized.linear.issue_thread.complete, false);
  });

  it("reports an incomplete thread when Linear has more comments than the page", async () => {
    const materialize = materializerFor(
      apiReturning({ comments: [comment("older", "hello", "user-1")], complete: false }, []),
    );

    const materialized = await materialize(launch("trigger"));

    assert.equal(materialized.linear.issue_thread.complete, false);
    assert.equal(materialized.linear.issue_thread.status, "materialized");
  });

  it("hydrates issue events too, which carry no triggering comment", async () => {
    const calls: { issueId: string; beforeCommentId?: string }[] = [];
    const materialize = materializerFor(
      apiReturning({ comments: [comment("older", "hello", "user-1")], complete: true }, calls),
    );

    const materialized = await materialize(launch(null));

    assert.deepEqual(calls, [{ issueId: "issue-1" }]);
    assert.equal(materialized.linear.issue_thread.comments.length, 1);
  });
});

function comment(id: string, body: string, authorId: string, name?: string) {
  return {
    id,
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
    author: { id: authorId, ...(name === undefined ? {} : { name }) },
  };
}

function apiReturning(
  result: LinearIssueCommentsResult,
  calls: { issueId: string; beforeCommentId?: string }[],
): LinearApiClient {
  return {
    readIssue: async () => undefined,
    createComment: async () => undefined,
    readIssueComments: async (input) => {
      calls.push({
        issueId: input.issueId,
        ...(input.beforeCommentId === undefined ? {} : { beforeCommentId: input.beforeCommentId }),
      });
      return result;
    },
  };
}

function launch(
  triggeringCommentId: string | null,
): TriggerContextMaterialization<LinearTriggerContext> {
  return {
    executionId: "execution-1",
    projectId: "project-1",
    organizationId: "org-1",
    providerEventReceiptId: "receipt-1",
    triggerContext: {
      provider: "linear" as const,
      target: {
        provider: "linear" as const,
        linearOrganizationId: "linear-org-1",
        issueId: "issue-1",
      },
      event: {
        linear: {
          event_type: triggeringCommentId === null ? "issue" : "comment",
          action: "create" as const,
          delivery_id: "delivery-1",
          connection_id: "connection-1",
          organization: { id: "linear-org-1" },
          actor: { id: "user-1" },
          issue: {
            id: "issue-1",
            title: "Add a button",
            description: null,
            project: null,
            state: null,
            assignee: null,
            label_ids: [],
          },
          comment:
            triggeringCommentId === null
              ? null
              : { id: triggeringCommentId, body: "@paseo not like that" },
        },
      },
    },
  };
}

const unusedStore = (): ProjectConfigurationStore => {
  throw new Error("configuration store is not used when materializing context");
};
