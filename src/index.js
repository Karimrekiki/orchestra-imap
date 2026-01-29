/**
 * IMAP Proxy Server for Invoice Orchestra
 *
 * A lightweight Express server that connects to Gmail's IMAP server.
 * Credentials are passed per-request, processed in-memory, never stored/logged.
 *
 * Deploy to: Railway, Render, Fly.io, or any Node.js host
 */

import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'orchestra-imap' });
});

// Create IMAP client
async function createClient(email, password) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false // Never log credentials
  });
  await client.connect();
  return client;
}

// Test connection
app.post('/test', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    await client.logout();
    res.json({ success: true });
  } catch (err) {
    const msg = err.message || 'Connection failed';

    if (msg.includes('AUTHENTICATIONFAILED')) {
      return res.status(401).json({ error: 'Invalid email or app password' });
    }
    if (msg.includes('Please log in via your web browser')) {
      return res.status(401).json({ error: 'Please use an App Password (2FA required)' });
    }

    res.status(500).json({ error: msg });
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Get mailbox stats quickly (for progress estimation)
app.post('/mailbox-stats', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    const status = await client.status('INBOX', { messages: true, recent: true });
    await client.logout();
    res.json({
      totalMessages: status.messages,
      recentMessages: status.recent
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to get mailbox stats' });
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Search for emails with PDF attachments - STREAMING version with real-time progress
// Uses Server-Sent Events (SSE) to stream progress updates
app.post('/search-stream', async (req, res) => {
  const { email, password, daysBack = 365, maxResults = 5000 } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let client = null;
  try {
    client = await createClient(email, password);

    // First, get total message count for progress estimation
    const status = await client.status('INBOX', { messages: true });
    const totalInMailbox = status.messages;

    sendEvent({
      type: 'start',
      totalInMailbox,
      estimatedPdfs: Math.round(totalInMailbox * 0.05) // ~5% typically have PDFs
    });

    await client.mailboxOpen('INBOX');

    // Handle "all time" scan when daysBack is very large (3650 = ~10 years)
    const effectiveDaysBack = daysBack >= 3650 ? 3650 : (daysBack || 365);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - effectiveDaysBack);

    const messages = [];
    let totalEmailsScanned = 0;
    let totalWithPdf = 0;
    const PROGRESS_INTERVAL = 50; // Send progress every 50 emails

    for await (const msg of client.fetch(
      { since: sinceDate },
      { envelope: true, bodyStructure: true, uid: true }
    )) {
      totalEmailsScanned++;

      const attachments = extractPdfAttachments(msg.bodyStructure);
      if (attachments.length > 0) {
        totalWithPdf++;
        if (messages.length < maxResults) {
          messages.push({
            uid: msg.uid,
            subject: msg.envelope.subject,
            from: formatAddress(msg.envelope.from?.[0]),
            date: msg.envelope.date?.toISOString(),
            attachments
          });
        }
      }

      // Send progress updates periodically
      if (totalEmailsScanned % PROGRESS_INTERVAL === 0) {
        sendEvent({
          type: 'progress',
          scanned: totalEmailsScanned,
          totalInMailbox,
          withPdf: totalWithPdf,
          percentComplete: Math.min(99, Math.round((totalEmailsScanned / totalInMailbox) * 100))
        });
      }
    }

    await client.logout();

    // Send final complete event with all messages
    sendEvent({
      type: 'complete',
      messages,
      totalEmailsScanned,
      totalWithPdf,
      daysBack: effectiveDaysBack
    });

    res.end();
  } catch (err) {
    sendEvent({ type: 'error', error: err.message || 'Search failed' });
    res.end();
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Search for emails with PDF attachments (non-streaming fallback)
// Returns all matching emails (no artificial limit) with total count
app.post('/search', async (req, res) => {
  const { email, password, daysBack = 365, maxResults = 5000 } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    await client.mailboxOpen('INBOX');

    // Handle "all time" scan when daysBack is very large (3650 = ~10 years)
    const effectiveDaysBack = daysBack >= 3650 ? 3650 : (daysBack || 365);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - effectiveDaysBack);

    const messages = [];
    let totalEmailsScanned = 0;
    let totalWithPdf = 0;

    for await (const msg of client.fetch(
      { since: sinceDate },
      { envelope: true, bodyStructure: true, uid: true }
    )) {
      totalEmailsScanned++;

      const attachments = extractPdfAttachments(msg.bodyStructure);
      if (attachments.length > 0) {
        totalWithPdf++;
        if (messages.length < maxResults) {
          messages.push({
            uid: msg.uid,
            subject: msg.envelope.subject,
            from: formatAddress(msg.envelope.from?.[0]),
            date: msg.envelope.date?.toISOString(),
            attachments
          });
        }
      }
    }

    await client.logout();
    res.json({
      messages,
      totalEmailsScanned,
      totalWithPdf,
      daysBack: effectiveDaysBack
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Search failed' });
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Download attachment
app.post('/attachment', async (req, res) => {
  const { email, password, messageUid, partId } = req.body;

  if (!email || !password || !messageUid || !partId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    await client.mailboxOpen('INBOX');

    // Try to fetch the attachment using the partId
    // partId format can be "1", "1.2", "2.1", etc.
    console.log(`[Attachment] Fetching UID ${messageUid}, part ${partId}`);

    try {
      const msg = await client.fetchOne(
        messageUid,
        { bodyParts: [partId] },
        { uid: true }
      );

      if (!msg || !msg.bodyParts || !msg.bodyParts.has(partId)) {
        // Try alternative part ID format (some servers use different numbering)
        console.log(`[Attachment] Part ${partId} not found, trying alternatives...`);

        // Get message structure to find correct part
        const structMsg = await client.fetchOne(
          messageUid,
          { bodyStructure: true },
          { uid: true }
        );

        if (structMsg?.bodyStructure) {
          const allParts = [];
          function collectParts(part, path = '1') {
            allParts.push({ path, part });
            if (part.childNodes) {
              part.childNodes.forEach((child, idx) => {
                collectParts(child, `${path}.${idx + 1}`);
              });
            }
          }
          collectParts(structMsg.bodyStructure);
          console.log(`[Attachment] Available parts: ${allParts.map(p => p.path).join(', ')}`);
        }

        return res.status(404).json({ error: `Attachment part ${partId} not found` });
      }

      const buffer = msg.bodyParts.get(partId);
      const base64 = buffer.toString('base64');

      await client.logout();
      res.json({ base64 });
    } catch (fetchErr) {
      console.error(`[Attachment] Fetch error for part ${partId}:`, fetchErr.message);

      // If the fetch fails, try downloading the entire message source and extract
      console.log(`[Attachment] Trying full message download as fallback...`);
      const fullMsg = await client.fetchOne(
        messageUid,
        { source: true, bodyStructure: true },
        { uid: true }
      );

      if (fullMsg?.source) {
        // Try to extract the attachment from the raw source
        // This is a fallback for when bodyParts fetch fails
        const source = fullMsg.source.toString('utf-8');

        // Find base64 content after the part boundary
        const base64Match = source.match(/Content-Transfer-Encoding:\s*base64[\r\n]+[\r\n]+([\s\S]+?)(?=--|\r\n\r\n--)/i);
        if (base64Match) {
          const base64Content = base64Match[1].replace(/[\r\n\s]/g, '');
          res.json({ base64: base64Content });
          return;
        }
      }

      throw fetchErr;
    }
  } catch (err) {
    console.error('Attachment download error:', err.message);
    res.status(500).json({ error: err.message || 'Download failed' });
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Search for emails by text query (for text invoice scanning)
app.post('/search-text', async (req, res) => {
  const { email, password, fromFilter, subjectFilter, daysBack = 30, maxResults = 50 } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    await client.mailboxOpen('INBOX');

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - daysBack);

    // Build IMAP search criteria
    // Note: IMAP search is limited - we can search by FROM, SUBJECT, SINCE
    const searchCriteria = { since: sinceDate };

    // Add FROM filter if provided
    if (fromFilter) {
      searchCriteria.from = fromFilter;
    }

    // Add SUBJECT filter if provided
    if (subjectFilter) {
      searchCriteria.subject = subjectFilter;
    }

    const messages = [];
    let count = 0;

    for await (const msg of client.fetch(
      searchCriteria,
      { envelope: true, bodyStructure: true, uid: true }
    )) {
      if (count >= maxResults) break;

      // Check if message has PDF attachments
      const pdfAttachments = extractPdfAttachments(msg.bodyStructure);
      const hasPdf = pdfAttachments.length > 0;

      messages.push({
        uid: msg.uid,
        subject: msg.envelope.subject,
        from: formatAddress(msg.envelope.from?.[0]),
        date: msg.envelope.date?.toISOString(),
        hasPdf,
        attachments: pdfAttachments
      });
      count++;
    }

    await client.logout();
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Search failed' });
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Get full message
app.post('/message', async (req, res) => {
  const { email, password, messageUid } = req.body;

  if (!email || !password || !messageUid) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    await client.mailboxOpen('INBOX');

    const msg = await client.fetchOne(
      messageUid,
      { envelope: true, bodyStructure: true, source: true, uid: true },
      { uid: true }
    );

    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const attachments = extractPdfAttachments(msg.bodyStructure);
    const { textBody, htmlBody } = parseEmailBody(msg.source);

    await client.logout();
    res.json({
      uid: msg.uid,
      subject: msg.envelope.subject,
      from: formatAddress(msg.envelope.from?.[0]),
      date: msg.envelope.date?.toISOString(),
      attachments,
      textBody,
      htmlBody,
      snippet: textBody?.substring(0, 200) || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to get message' });
  } finally {
    if (client) try { await client.logout(); } catch {}
  }
});

// Extract PDF attachments from body structure
function extractPdfAttachments(bodyStructure) {
  const attachments = [];

  function walk(part, partId = '1') {
    if (!part) return;

    const mimeType = `${part.type || ''}/${part.subtype || ''}`.toLowerCase();
    const filename = part.dispositionParameters?.filename ||
                     part.parameters?.name || '';

    if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      attachments.push({
        filename: filename || 'document.pdf',
        mimeType,
        size: part.size || 0,
        partId
      });
    }

    if (part.childNodes) {
      part.childNodes.forEach((child, index) => {
        walk(child, `${partId}.${index + 1}`);
      });
    }
  }

  walk(bodyStructure);
  return attachments;
}

// Format email address
function formatAddress(addr) {
  if (!addr) return '';
  const name = addr.name || '';
  const email = `${addr.mailbox || ''}@${addr.host || ''}`;
  return name ? `${name} <${email}>` : email;
}

// Parse email body (simplified)
function parseEmailBody(source) {
  if (!source) return { textBody: '', htmlBody: '' };

  const content = source.toString('utf-8');
  let textBody = '';
  let htmlBody = '';

  const textMatch = content.match(
    /Content-Type: text\/plain[^\r\n]*\r\n(?:Content-Transfer-Encoding:[^\r\n]*\r\n)?\r\n([\s\S]*?)(?=--|\r\n\r\n--)/i
  );
  if (textMatch) {
    textBody = decodeContent(textMatch[1].trim());
  }

  const htmlMatch = content.match(
    /Content-Type: text\/html[^\r\n]*\r\n(?:Content-Transfer-Encoding:[^\r\n]*\r\n)?\r\n([\s\S]*?)(?=--|\r\n\r\n--)/i
  );
  if (htmlMatch) {
    htmlBody = decodeContent(htmlMatch[1].trim());
  }

  return { textBody, htmlBody };
}

// Decode quoted-printable/base64
function decodeContent(content) {
  if (content.includes('=')) {
    content = content
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return content;
}

app.listen(PORT, () => {
  console.log(`IMAP proxy server running on port ${PORT}`);
});
