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

// ── Send a single message to Agentforce session ───────────
async function sendAgentMessage(token, sessionId, text, sequenceId) {
  const res = await fetch(
    `https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          sequenceId,
          type: 'Text',
          text,
        },
        variables: [],
      }),
    }
  );

  const responseText = await res.text();
  console.log(`Message (seq ${sequenceId}) response status:`, res.status);
  console.log(`Message (seq ${sequenceId}) response:`, responseText);

  if (!res.ok) {
    throw new Error(`Message send failed ${res.status}: ${responseText}`);
  }

  return JSON.parse(responseText);
}

// ── Trigger Agentforce ────────────────────────────────────
async function triggerAgentforce(emailData) {
  let sessionId = null;
  const token = await getSalesforceToken();

  try {
    const AGENT_ID  = process.env.SF_AGENT_ID || '0XxKh000000gWi3KAE';
    const API_BASE  = 'https://api.salesforce.com/einstein/ai-agent/v1';

    // ── Step 1: Create Session ──────────────────────────
    console.log('Creating Agentforce session...');
    const sessionRes = await fetch(
      `${API_BASE}/agents/${AGENT_ID}/sessions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          externalSessionKey: `gmail-${Date.now()}`,
          instanceConfig: {
            endpoint: process.env.SF_INSTANCE_URL,
          },
          streamingCapabilities: {
            chunkTypes: ['Text'],
          },
          bypassUser: true,
        }),
      }
    );

    if (!sessionRes.ok) {
      const errText = await sessionRes.text();
      throw new Error(`Session creation failed ${sessionRes.status}: ${errText}`);
    }

    const sessionData = await sessionRes.json();
    sessionId = sessionData.sessionId || sessionData.id;
    console.log('Agentforce session created:', sessionId);

    if (!sessionId) {
      throw new Error('Session ID not received: ' + JSON.stringify(sessionData));
    }

    // ── Step 2: Send Email as First Message ─────────────
    const prompt = `You are an autonomous email processing agent.

Your purpose is to analyze incoming emails and automatically create Salesforce Leads when appropriate.

Rules:
1. Analyze the email content and determine whether it is spam, marketing newsletter, automated notification, or a potential sales inquiry.
2. If spam, newsletter, or automated: do NOT create any records. Return the reason for rejection.
3. If it indicates interest in products, services, consulting, partnerships, pricing, demos, implementations, or business discussions: treat sender as a potential lead.
4. Extract all available information: First Name, Last Name, Email Address, Company, Phone Number, Lead Description.
5. When sufficient information is available: immediately invoke the CreateSalesLeadRecord action. Do NOT ask for confirmation. Do NOT ask follow-up questions. Execute automatically.
6. This is a backend automation workflow. Assume permission to create records has already been granted.
7. After successful creation: return the Salesforce Lead Id and a summary.
8. If required fields cannot be determined: do not create a lead. Return the reason.

Never request confirmation before creating a lead. Always execute automatically when criteria are met.

EMAIL DETAILS
From: ${emailData.from}
Subject: ${emailData.subject}
Date: ${emailData.date}
Body:
${emailData.body}`;

    const firstResponse = await sendAgentMessage(token, sessionId, prompt, 1);

    // ── Step 3: Auto-reply if agent asks for confirmation ─
    let agentMessage = '';

    // Extract message text from response
    if (firstResponse?.messages?.length > 0) {
      agentMessage = firstResponse.messages[0]?.message || '';
    } else if (firstResponse?.outputValues?.agentResponse) {
      try {
        const parsed = JSON.parse(firstResponse.outputValues.agentResponse);
        agentMessage = parsed?.value || '';
      } catch {
        agentMessage = firstResponse.outputValues.agentResponse || '';
      }
    }

    console.log('Agent message received:', agentMessage);

    // Check if agent is asking for confirmation
    const askingForConfirmation =
      agentMessage.toLowerCase().includes('yes') ||
      agentMessage.toLowerCase().includes('proceed') ||
      agentMessage.toLowerCase().includes('confirm') ||
      agentMessage.toLowerCase().includes('would you like') ||
      agentMessage.toLowerCase().includes('shall i') ||
      agentMessage.toLowerCase().includes('go ahead');

    if (askingForConfirmation) {
      console.log('Agent asked for confirmation — auto-replying "yes"...');
      const confirmResponse = await sendAgentMessage(token, sessionId, 'yes', 2);
      console.log('Confirmation response:', JSON.stringify(confirmResponse, null, 2));
    }

    console.log('Agentforce processing complete.');

  } catch (error) {
    console.error('Agentforce Error:', error.message);
  } finally {
    // ── Step 4: Always End Session (cleanup) ────────────
    if (sessionId) {
      try {
        await fetch(
          `https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        console.log('Agentforce session closed:', sessionId);
      } catch (err) {
        console.error('Session close error:', err.message);
      }
    }
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

// ── REST Endpoints ─────────────────────────────────────────
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

// Auto-renew Gmail watch every 6 days
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
}, 4 * 60 * 1000);
