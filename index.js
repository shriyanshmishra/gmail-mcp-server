import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { google } from 'googleapis';
import express from 'express';
import { z } from 'zod';

const app = express();
app.use(express.json());

// ── OAuth 2.0 Client (Gmail) ─────────────────────────────
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
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  return '';
}

// ── Salesforce Auth (Client Credentials Flow) ────────────
async function getSalesforceToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });

  const res = await fetch(
    `${process.env.SF_INSTANCE_URL}/services/oauth2/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    }
  );

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('SF auth failed: ' + JSON.stringify(data));
  }
  console.log('Salesforce token obtained successfully.');
  return data.access_token;
}

// ── Trigger Agentforce via correct endpoints ──────────────
async function triggerAgentforce(emailData) {
  try {
    // Step 1 — Get Salesforce Token
    const token = await getSalesforceToken();

    // HARDCODED SESSION ID FOR TESTING
    const sessionId = 'a20ef808-4c87-4b40-a74c-23c0afde11f0';
    console.log('Using hardcoded session ID:', sessionId);

    // Step 2 — Send message to Agentforce
    console.log('Sending message to Agentforce...');
    const agentRes = await fetch(
      `${process.env.SF_INSTANCE_URL}/services/data/v66.0/actions/custom/generateAiAgentResponse/Gmail_Lead_Ingestion_Agent`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: [{
            sessionId: sessionId,
            userMessage: `A new email has arrived in the Gmail inbox. Please process it and create a Salesforce Lead if it is a genuine inbound sales inquiry.

SKIP if: spam, newsletter, promotional, auto-reply, out-of-office, notification.
CREATE LEAD if: genuine sales inquiry, demo request, pricing question, product interest.

Email Details:
From: ${emailData.from}
Subject: ${emailData.subject}
Date: ${emailData.date}
Body:
${emailData.body}

If qualifying: extract First Name, Last Name, Email, Company, Phone and create the lead.
If not qualifying: explain why it was skipped.`
          }]
        }),
      }
    );

    const agentText = await agentRes.text();
    console.log('Agent response status:', agentRes.status);
    console.log('Agent response:', agentText);

  } catch (error) {
    console.error('Agentforce trigger error:', error.message);
  }
}

// ── Spam Check ────────────────────────────────────────────
async function isSpamOrUnwanted(messageId) {
  try {
    const msg = await getGmail().users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });

    const labels = msg.data.labelIds || [];
    console.log('Message labels:', labels);

    if (labels.includes('SPAM') || labels.includes('TRASH')) {
      console.log('Skipping — Gmail marked as SPAM or TRASH');
      return true;
    }

    if (!labels.includes('INBOX')) {
      console.log('Skipping — not in INBOX');
      return true;
    }

    return false;
  } catch (error) {
    console.error('Spam check error:', error.message);
    return false;
  }
}

// ── Store last known historyId ────────────────────────────
let lastHistoryId = null;

// ── Gmail Push Webhook ────────────────────────────────────
app.post('/gmail-webhook', async (req, res) => {
  res.status(200).send('OK');

  try {
    const message = req.body?.message;
    if (!message?.data) {
      console.log('No message data received');
      return;
    }

    const decoded = JSON.parse(
      Buffer.from(message.data, 'base64').toString('utf-8')
    );
    console.log('Gmail push received:', JSON.stringify(decoded));

    const newHistoryId = decoded.historyId;
    if (!newHistoryId) return;

    if (!lastHistoryId) {
      console.log('First push — storing historyId:', newHistoryId);
      lastHistoryId = newHistoryId;
      return;
    }

    const gmail = getGmail();
    let history;
    try {
      history = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: lastHistoryId,
        historyTypes: ['messageAdded'],
      });
    } catch (err) {
      console.log('History fetch failed:', err.message);
      lastHistoryId = newHistoryId;
      return;
    }

    lastHistoryId = newHistoryId;

    const records = history.data.history || [];
    console.log('History records found:', records.length);

    if (records.length === 0) {
      console.log('No new messages in history');
      return;
    }

    for (const record of records) {
      if (!record.messagesAdded) continue;

      for (const added of record.messagesAdded) {
        const messageId = added.message.id;
        console.log('Processing message:', messageId);

        // Spam check
        const spam = await isSpamOrUnwanted(messageId);
        if (spam) {
          console.log('Skipped — spam or unwanted:', messageId);
          continue;
        }

        // Get full email
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const get = name => headers.find(h => h.name === name)?.value || '';

        const emailData = {
          from: get('From'),
          subject: get('Subject'),
          date: get('Date'),
          body: extractBody(msg.data.payload),
        };

        console.log('Email from:', emailData.from);
        console.log('Subject:', emailData.subject);

        // Trigger Agentforce
        await triggerAgentforce(emailData);
      }
    }

  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

// ── Register Gmail Watch ──────────────────────────────────
async function registerGmailWatch() {
  try {
    const res = await getGmail().users.watch({
      userId: 'me',
      requestBody: {
        labelIds: ['INBOX'],
        topicName: process.env.PUBSUB_TOPIC_NAME,
      },
    });
    console.log('Gmail watch registered successfully');
    console.log('Expires:', new Date(parseInt(res.data.expiration)).toISOString());
  } catch (error) {
    console.error('Gmail watch error:', error.message);
  }
}

// ── REST Endpoints (Salesforce External Services) ─────────
app.get('/list', async (req, res) => {
  try {
    const maxResults = parseInt(req.query.maxResults) || 10;
    const result = await getGmail().users.messages.list({
      userId: 'me', q: 'is:unread', maxResults
    });
    res.json(result.data.messages || []);
  } catch (error) {
    console.error('/list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/get', async (req, res) => {
  try {
    const { messageId } = req.query;
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    const msg = await getGmail().users.messages.get({
      userId: 'me', id: messageId, format: 'full'
    });
    const headers = msg.data.payload?.headers || [];
    const get = name => headers.find(h => h.name === name)?.value || '';
    res.json({
      from: get('From'), subject: get('Subject'),
      date: get('Date'), body: extractBody(msg.data.payload)
    });
  } catch (error) {
    console.error('/get error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/search', async (req, res) => {
  try {
    const { q, maxResults } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const result = await getGmail().users.messages.list({
      userId: 'me', q, maxResults: parseInt(maxResults) || 10
    });
    res.json(result.data.messages || []);
  } catch (error) {
    console.error('/search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── MCP Endpoint (for Agentforce manual preview) ─────────
function registerTools(server) {
  server.tool('gmail_list_messages', 'List unread Gmail messages.',
    { maxResults: z.number().optional().default(10) },
    async ({ maxResults }) => {
      const res = await getGmail().users.messages.list({ userId: 'me', q: 'is:unread', maxResults });
      return { content: [{ type: 'text', text: JSON.stringify(res.data.messages || []) }] };
    }
  );
  server.tool('gmail_get_message', 'Get full email by ID.',
    { messageId: z.string() },
    async ({ messageId }) => {
      const msg = await getGmail().users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const headers = msg.data.payload?.headers || [];
      const get = name => headers.find(h => h.name === name)?.value || '';
      return { content: [{ type: 'text', text: JSON.stringify({ from: get('From'), subject: get('Subject'), date: get('Date'), body: extractBody(msg.data.payload) }) }] };
    }
  );
  server.tool('gmail_search', 'Search Gmail messages.',
    { query: z.string(), maxResults: z.number().optional().default(10) },
    async ({ query, maxResults }) => {
      const res = await getGmail().users.messages.list({ userId: 'me', q: query, maxResults });
      return { content: [{ type: 'text', text: JSON.stringify(res.data.messages || []) }] };
    }
  );
}

// FIX: Create new McpServer per request — global instance crashes on second request
app.all('/mcp', async (req, res) => {
  try {
    const server = new McpServer({ name: 'gmail-mcp-server', version: '1.0.0' });
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── OAuth Helper Endpoints ────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(String(req.query.code));
    oauth2Client.setCredentials(tokens);
    console.log('REFRESH TOKEN:', tokens.refresh_token);
    res.send('OAuth complete. Copy the refresh token from server logs.');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.get('/auth', (req, res) => {
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent',
  }));
});

app.get('/', (req, res) => res.json({ status: 'Gmail MCP Server running', version: '1.0.0' }));

// ── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`Gmail MCP Server running on port ${PORT}`);
  await registerGmailWatch();
});

// Auto-renew Gmail watch every 6 days (expires after 7 days)
setInterval(registerGmailWatch, 6 * 24 * 60 * 60 * 1000);

// ── Keep Server Awake (Render free tier) ──────────────────
const SELF_URL = 'https://gmail-mcp-server-himw.onrender.com/';
setInterval(async () => {
  try {
    await fetch(SELF_URL);
    console.log('Keep-alive ping sent');
  } catch (e) {
    console.error('Keep-alive failed:', e.message);
  }
}, 4 * 60 * 1000); // every 4 minutes
