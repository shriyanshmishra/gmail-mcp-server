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

// ── Trigger Agentforce with raw email payload ─────────────
async function triggerAgentforce(emailData) {
  try {
    const token = await getSalesforceToken();

    const AGENT_ID = '0XxKh000000gWi3KAE';
    const BASE_URL = 'https://cl1771317101187.my.salesforce.com';

    const prompt = `
You are an autonomous email processing agent.

Your purpose is to analyze incoming emails and automatically create Salesforce Leads when appropriate.

Rules:

1. Analyze the email content and determine whether it is:
   - Spam
   - Marketing newsletter
   - Automated notification
   - Potential sales inquiry
   - Business opportunity

2. If the email is spam, a newsletter, or an automated notification:
   - Do not create any records.
   - Return the reason for rejection.

3. If the email indicates interest in products, services, consulting, partnerships, pricing, demos, implementations, or business discussions:
   - Treat the sender as a potential lead.
   - Extract all available information:
     * First Name
     * Last Name
     * Email Address
     * Company
     * Phone Number
     * Lead Description / Notes

4. When sufficient information is available:
   - Immediately invoke the CreateSalesLeadRecord action.
   - Do NOT ask for user confirmation.
   - Do NOT ask follow-up questions.
   - Do NOT wait for approval.
   - Execute the action automatically.

5. This is a backend automation workflow.
   - The incoming email is the source of truth.
   - Assume permission to create records has already been granted.

6. After successful creation:
   - Return the Salesforce Lead Id.
   - Return a summary of the extracted information.

7. If required fields cannot be determined with reasonable confidence:
   - Do not create a lead.
   - Return the reason.

Never request confirmation before creating a lead. Always execute automatically when criteria are met.

EMAIL DETAILS

From: ${emailData.from}
Subject: ${emailData.subject}
Date: ${emailData.date}

Body:
${emailData.body}
`;

    // ── Step 1: Create Session ──────────────────────────
    console.log('Creating Agentforce session...');
    const sessionRes = await fetch(
      `${BASE_URL}/services/einstein/ai/v1/agents/${AGENT_ID}/sessions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          externalSessionKey: `gmail-${Date.now()}`,
          bypassUser: true,
        }),
      }
    );

    if (!sessionRes.ok) {
      const errText = await sessionRes.text();
      throw new Error(`Session creation failed ${sessionRes.status}: ${errText}`);
    }

    const sessionData = await sessionRes.json();
    const sessionId = sessionData.sessionId || sessionData.id;
    console.log('Agentforce Session created:', sessionId);

    if (!sessionId) {
      throw new Error('Session ID not received from Agentforce');
    }

    // ── Step 2: Send Message ────────────────────────────
    console.log('Sending message to Agentforce...');
    const msgRes = await fetch(
      `${BASE_URL}/services/einstein/ai/v1/agents/${AGENT_ID}/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
          bypassUser: true,
        }),
      }
    );

    if (!msgRes.ok) {
      const errText = await msgRes.text();
      throw new Error(`Message send failed ${msgRes.status}: ${errText}`);
    }

    const result = await msgRes.json();
    console.log('Agentforce Response:', JSON.stringify(result, null, 2));

    // ── Step 3: End Session (cleanup) ──────────────────
    await fetch(
      `${BASE_URL}/services/einstein/ai/v1/agents/${AGENT_ID}/sessions/${sessionId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    console.log('Agentforce session closed.');

    return result;

  } catch (error) {
    console.error('Agentforce Error:', error.message);
    throw error;
  }
}

// ── Spam Check ────────────────────────────────────────────
async function isSpamOrUnwanted(messageId) {
  try {
    const gmail = getGmail();
    const msg = await gmail.users.messages.get({
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
      console.log('History fetch failed, updating historyId:', err.message);
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

        const spam = await isSpamOrUnwanted(messageId);
        if (spam) {
          console.log('Skipped — spam or unwanted:', messageId);
          continue;
        }

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
    const gmail = getGmail();
    const res = await gmail.users.watch({
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

// ── MCP Endpoint ──────────────────────────────────────────
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
const SELF_URL = process.env.SELF_URL || 'https://gmail-mcp-server-himw.onrender.com/';
setInterval(async () => {
  try {
    await fetch(SELF_URL);
    console.log('Keep-alive ping sent');
  } catch (e) {
    console.error('Keep-alive failed:', e.message);
  }
}, 10 * 60 * 1000);