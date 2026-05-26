import dotenv from "dotenv";
dotenv.config();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "ghl-mcp",
  version: "1.0.0"
});

const locationId = process.env.GHL_MA_LOCATION_ID;
const apiKey = process.env.GHL_MA_PIT_TOKEN;

server.tool(
  "search_contact",
  {
    email: z.string()
  },
  async ({ email }) => {
    try {

      console.error("Searching:", email);

      const url =
        `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(email)}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: "2021-07-28"
        }
      });

      const data = await response.json();

      console.error("FULL RESPONSE:", JSON.stringify(data, null, 2));

      const contacts = data?.contacts ?? data?.data?.contacts ?? [];

      if (!contacts.length) {
        return {
          content: [
            {
              type: "text",
              text: "No contacts found."
            }
          ]
        };
      }

      const formatted = contacts
        .map(c =>
          `${c.firstName || ""} ${c.lastName || ""} - ${c.email}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${contacts.length} contact(s):\n${formatted}`
          }
        ]
      };

    } catch (error) {

      console.error("Error:", error);

      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`
          }
        ]
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("GHL MCP Server Running");