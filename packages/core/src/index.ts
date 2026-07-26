export type { VleConfig, VleConfigInput } from "./config";
export { resolveConfig } from "./config";

export { devGate } from "./devGate";
export { checkDevGate } from "./devGateCore";
export type { DevGateResult } from "./devGateCore";

export { instrumentJsx } from "./instrumentJsx";
export type { InstrumentResult } from "./instrumentJsx";

export { historyStatus, pushHistory, undo, redo } from "./history";
export type { HistoryStatus } from "./history";

export { applyPatch, resolveProjectFile } from "./patch";
export type { PatchRequest, PatchResult } from "./patch";

export { scanDesignSystem } from "./designSystemScan";
export type { DesignSystemComponent } from "./designSystemScan";

export { scanCreatives, resolveCreativeFile, copyCreativeToPublic } from "./creativesScan";
export type { CreativeAsset, CopyToPublicResult } from "./creativesScan";

export { locateElement, buildAgentPrompt, buildChatPrompt } from "./agentPrompt";
export type { LocatedElement } from "./agentPrompt";

export {
  startAgentJob,
  getJobStatus,
  refineJob,
  startPreview,
  applyJob,
  discardJob,
} from "./agentRunner";
export type { StartAgentJobRequest, StartResult, JobPublicView } from "./agentRunner";

export {
  startChatSession,
  getChatStatus,
  sendChatMessage,
  applyChatSession,
  discardChatSession,
  listChatSessions,
  attachChatFile,
} from "./chatRunner";
export type { ChatMessage, ChatPublicView, ChatSummary, AttachChatFileResult } from "./chatRunner";
