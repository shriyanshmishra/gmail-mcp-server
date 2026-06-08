import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { google } from 'googleapis';
import express from 'express';
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

// ── Shared Gmail helper ───────────────────────────────────
function getGmail() {
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function extractBody(payload) {
  const parts = payload?.parts || [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
  }
  // fallback: check body directly
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  return '';
}

// ════════════════════════════════════════════════════════
// REST ENDPOINTS (for Salesforce External Services)
// ════════════════════════════════════════════════════════

// GET /list?maxResults=10
app.get('/list', async (req, res) => {
  try {
    const maxResults = parseInt(req.query.maxResults) || 10;
    const gmail = getGmail();
    const result = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults,
    });
    res.json(result.data.messages || []);
  } catch (error) {
    console.error('/list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /get?messageId=xxx
app.get('/get', async (req, res) => {
  try {
    const messageId = req.query.messageId;
    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required' });
    }
    const gmail = getGmail();
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const headers = msg.data.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date    = headers.find(h => h.name === 'Date')?.value || '';
    const body    = extractBody(msg.data.payload);
    res.json({ from, subject, date, body });
  } catch (error) {
    console.error('/get error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /search?q=is:unread&maxResults=10
app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) {
      return res.status(400).json({ error: 'q (query) is required' });
    }
    const maxResults = parseInt(req.query.maxResults) || 10;
    const gmail = getGmail();
    const result = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults,
    });
    res.json(result.data.messages || []);
  } catch (error) {
    console.error('/search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ════════════════════════════════════════════════════════
// MCP ENDPOINT (Streamable HTTP — kept for future use)
// ════════════════════════════════════════════════════════

function registerTools(server) {
  server.tool(
    'gmail_list_messages',
    'List recent unread messages from Gmail inbox.',
    { maxResults: z.number().optional().default(10) },
    async ({ maxResults }) => {
      const gmail = getGmail();
      const res = await gmail.users.messages.list({
        userId: 'me', q: 'is:unread', maxResults,
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data.messages || []) }] };
    }
  );

  server.tool(
    'gmail_get_message',
    'Retrieve the full content of a Gmail message by ID.',
    { messageId: z.string() },
    async ({ messageId }) => {
      const gmail = getGmail();
      const msg = await gmail.users.messages.get({
        userId: 'me', id: messageId, format: 'full',
      });
      const headers = msg.data.payload?.headers || [];
      const from    = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date    = headers.find(h => h.name === 'Date')?.value || '';
      const body    = extractBody(msg.data.payload);
      return { content: [{ type: 'text', text: JSON.stringify({ from, subject, date, body }) }] };
    }
  );

  server.tool(
    'gmail_search',
    'Search Gmail messages by query string.',
    { query: z.string(), maxResults: z.number().optional().default(10) },
    async ({ query, maxResults }) => {
      const gmail = getGmail();
      const res = await gmail.users.messages.list({
        userId: 'me', q: query, maxResults,
      });
      return { content: [{ type: 'text', text: JSON.stringify(res.data.messages || []) }] };
    }
  );
}

app.all('/mcp', async (req, res) => {
  try {
    const server = new McpServer({
      name: 'gmail-mcp-server',
      version: '1.0.0',
    });
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP handler error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ════════════════════════════════════════════════════════
// OAuth Endpoints
// ════════════════════════════════════════════════════════

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);
    console.log('REFRESH TOKEN:', tokens.refresh_token);
    res.send('OAuth complete. Copy the refresh token from server logs.');
  } catch (error) {
    res.status(500).send('OAuth error: ' + error.message);
  }
});

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
  });
  res.redirect(url);
});

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Gmail MCP Server running', version: '1.0.0' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Gmail MCP Server running on port ${PORT}`));
