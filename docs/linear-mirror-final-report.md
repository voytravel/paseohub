# Linear mirrors close at the durable report

For routes with `publish_issue_comment: true`, the reserved Linear report is the
turn's final-output boundary. Streamed thoughts and actions must not follow its
native response: a later activity can make Linear show an already finished turn
as active again. This rule does not depend on the provider's tool names; Codex
can wrap several Hub calls in a single `functions.exec` tool event.

The daemon lifecycle passes the durable execution ID through the dynamic
provider runtime. The Linear mirror consults durable state only when it has a
nonempty activity batch. It shares the `execution.prompt:<id>` advisory lock
with native report publication and conversation input delivery. An activity
already in flight completes before the response; a queued activity sees the
report reservation and is discarded, including any buffered text.

Before publishing, the mirror verifies the live execution, current turn and
native session, and the signed connection's current application identity. The
execution output retains its initial dispatch key, while the trigger target
identifies the incoming conversational turn; these keys are not interchangeable.
A newly accepted turn resets its mirror. A queued batch from an old turn cannot
publish into or close the replacement mirror.

Without an execution ID or durable report storage, a route opting into durable
reports fails closed for streamed activities and logs the failure. Routes that
do not enable durable reports retain their existing mirror behavior. No daemon
protocol change or permission expansion is required.

Regression coverage exercises wrapped completion calls, buffered late thoughts,
pending report delivery, activity/report races, new turns in the same or a new
native session, stale queued batches, connection replacement, missing durable
dependencies, and execution-ID forwarding through both runtime boundaries.
