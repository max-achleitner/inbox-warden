import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transporter } from "nodemailer";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, transport: Transporter, fromAddress: string) {
  server.tool(
    "send_email",
    "Send an email via SMTP",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, cc, bcc }) => {
      try {
        const info = await transport.sendMail({
          from: fromAddress,
          to,
          cc,
          bcc,
          subject,
          text: body,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              messageId: info.messageId,
              to,
              subject,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error sending email: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
