import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { google } from 'googleapis';
import express, { Request, Response } from 'express';
import { z } from 'zod';

const app = express();
app.use(express.json());

// ── OAuth 2.1 Client ──────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

if (process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
}

// ── MCP Server Instance ───────────────────────────────────
const server = new McpServer({
  name: 'gmail-mcp-server',
  version: '1.0.0',
});

// ── Tool 1: gmail_list_messages ───────────────────────────
server.tool(
  'gmail_list_messages',
  'List recent unread messages from Gmail inbox.',
  { maxResults: z.number().optional().default(10) },
  async ({ maxResults }) => {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const res = await gmail.users.messages.list({
      userId: 'me', q: 'is:unread', maxResults,
    });
    return { content: [{ type: 'text',
      text: JSON.stringify(res.data.messages || []) }] };
  }
);

// ── Tool 2: gmail_get_message ─────────────────────────────
server.tool(
  'gmail_get_message',
  'Retrieve the full content of a Gmail message by ID.',
  { messageId: z.string() },
  async ({ messageId }) => {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const msg = await gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'full',
    });
    const parts = msg.data.payload?.parts || [];
    let body = '';
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
        break;
      }
    }
    const headers = msg.data.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date    = headers.find(h => h.name === 'Date')?.value || '';
    return { content: [{ type: 'text',
      text: JSON.stringify({ from, subject, date, body }) }] };
  }
);

// ── Tool 3: gmail_search ──────────────────────────────────
server.tool(
  'gmail_search',
  'Search Gmail messages by query string (Gmail search syntax).',
  { query: z.string(), maxResults: z.number().optional().default(10) },
  async ({ query, maxResults }) => {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const res = await gmail.users.messages.list({
      userId: 'me', q: query, maxResults,
    });
    return { content: [{ type: 'text',
      text: JSON.stringify(res.data.messages || []) }] };
  }
);

// ── Streamable HTTP Endpoint (/mcp) ───────────────────────
app.all('/mcp', async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── OAuth Callback ────────────────────────────────────────
app.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(String(code));
  oauth2Client.setCredentials(tokens);
  console.log('REFRESH TOKEN:', tokens.refresh_token);
  res.send('OAuth complete. Copy the refresh token from server logs.');
});

// ── Auth URL helper ───────────────────────────────────────
app.get('/auth', (req: Request, res: Response) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
  });
  res.redirect(url);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`Gmail MCP Server running on port ${PORT}`)
);
