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

// Search for emails with PDF attachments
// Returns all matching emails (no artificial limit) with total count
app.post('/search', async (req, res) => {
  const { email, password, daysBack = 30, maxResults = 500 } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  let client = null;
  try {
    client = await createClient(email, password);
    await client.mailboxOpen('INBOX');

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - daysBack);

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
      daysBack
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

    // Use fetchOne with bodyParts to get the specific part
    const msg = await client.fetchOne(
      messageUid,
      { bodyParts: [partId] },
      { uid: true }
    );

    if (!msg || !msg.bodyParts || !msg.bodyParts.has(partId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const buffer = msg.bodyParts.get(partId);
    const base64 = buffer.toString('base64');

    await client.logout();
    res.json({ base64 });
  } catch (err) {
    console.error('Attachment download error:', err);
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
