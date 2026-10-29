import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { proposedWorkflowRunId, requestedSecret } from '@/lib/opencode/tools';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import { ShownPage } from './HtmlRenderFrame';
import { SecretRequestCard } from './SecretRequestCard';

/**
 * What a call the chat shows in place (`isShownInPlace`) draws instead of its
 * row: the run a `workflow.run` call proposed, the card a secret request asks
 * on, else the page it showed.
 */
export function ShownToolCard({ part }: { part: ToolPart }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  const secret = React.useMemo(() => requestedSecret(part.tool, part.state), [part.tool, part.state]);
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  if (secret) return <SecretRequestCard part={part} request={secret} />;
  return <ShownPage part={part} />;
}
