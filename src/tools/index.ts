import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import * as listAccounts from "./list-accounts.js";
import * as healthCheck from "./health-check.js";
import * as signIn from "./sign-in.js";
import * as listFolders from "./list-folders.js";
import * as searchEmails from "./search-emails.js";
import * as readEmail from "./read-email.js";
import * as getEmailCount from "./get-email-count.js";
import * as downloadAttachment from "./download-attachment.js";
import * as getQuota from "./get-quota.js";
import * as markAsRead from "./mark-as-read.js";
import * as moveEmail from "./move-email.js";
import * as flagEmail from "./flag-email.js";
import * as createDraft from "./create-draft.js";
import * as replyDraft from "./reply-draft.js";
import * as manageFolders from "./manage-folders.js";
import * as sendEmail from "./send-email.js";
import * as sendDraft from "./send-draft.js";
import * as deleteEmail from "./delete-email.js";
import * as saveAttachment from "./save-attachment.js";
import * as organizeByFilter from "./organize-by-filter.js";
import * as getThread from "./get-thread.js";
import * as forwardDraft from "./forward-draft.js";
import * as summarizeSenders from "./summarize-senders.js";

export type ToolRegistration = (server: McpServer, app: AppContext) => void;

/** Every tool; each registers itself only if some account grants its permission tier. */
export const ALL_TOOLS: ToolRegistration[] = [
  // always available
  listAccounts.register,
  healthCheck.register,
  signIn.register,
  // read
  listFolders.register,
  searchEmails.register,
  readEmail.register,
  getEmailCount.register,
  downloadAttachment.register,
  getQuota.register,
  getThread.register,
  summarizeSenders.register,
  // write
  markAsRead.register,
  moveEmail.register,
  flagEmail.register,
  createDraft.register,
  replyDraft.register,
  forwardDraft.register,
  saveAttachment.register,
  organizeByFilter.register,
  manageFolders.registerCreate,
  manageFolders.registerDelete,
  manageFolders.registerRename,
  // send
  sendEmail.register,
  sendDraft.register,
  // delete
  deleteEmail.register,
];
