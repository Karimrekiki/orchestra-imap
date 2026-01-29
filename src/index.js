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

// Create IMAP client with timeout
async function createClient(email, password, timeout = 30000) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false, // Never log credentials
    socketTimeout: timeout,
    greetingTimeout: 15000,
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
// Supports resuming from a specific UID for interrupted scans
// Supports incremental scanning with sinceUid for periodic updates
app.post('/search-stream', async (req, res) => {
  const {
    email,
    password,
    daysBack = 365,
    maxResults = 5000,
    resumeAfterUid = null,  // Resume after this UID (for interrupted scans - lower bound)
    sinceUid = null,        // Only fetch emails with UID > sinceUid (for incremental scans)
    previousScanned = 0,     // Count from previous partial scan
    previousWithPdf = 0      // PDFs found in previous partial scan
  } = req.body;

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

    const isIncremental = !!sinceUid;
    sendEvent({
      type: 'start',
      totalInMailbox,
      estimatedPdfs: isIncremental ? 10 : Math.round(totalInMailbox * 0.05), // Fewer expected for incremental
      resuming: !!resumeAfterUid,
      incremental: isIncremental,
      sinceUid,
      previousScanned,
      previousWithPdf
    });

    await client.mailboxOpen('INBOX');

    // Handle "all time" scan when daysBack is very large (3650 = ~10 years)
    const effectiveDaysBack = daysBack >= 3650 ? 3650 : (daysBack || 365);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - effectiveDaysBack);

    const messages = [];
    const pendingMessages = []; // Messages waiting to be sent
    let totalEmailsScanned = previousScanned;
    let totalWithPdf = previousWithPdf;
    let lastProcessedUid = resumeAfterUid;
    let skippedToResume = 0;
    const PROGRESS_INTERVAL = 50; // Send progress every 50 emails
    const PDF_BATCH_SIZE = 10;   // Send PDF batches every 10 PDFs found
    const scanStartTime = Date.now();

    // First, search for all matching UIDs so we can process newest first
    // For incremental scans, we use UID range instead of date filter
    let searchCriteria;
    if (sinceUid) {
      // Incremental scan: only emails newer than sinceUid
      searchCriteria = { uid: `${sinceUid + 1}:*` };
      console.log(`[Search] Incremental scan for emails with UID > ${sinceUid}`);
    } else {
      // Full scan: use date filter
      searchCriteria = { since: sinceDate };
    }

    const searchResult = await client.search(searchCriteria, { uid: true });
    const allUids = Array.isArray(searchResult) ? searchResult : [];

    // Sort UIDs in descending order (newest first - higher UID = newer)
    allUids.sort((a, b) => b - a);

    const scanType = sinceUid ? `incremental (UID > ${sinceUid})` : `full (since ${sinceDate.toISOString()})`;
    console.log(`[Search] Found ${allUids.length} emails for ${scanType} scan, processing newest first`);

    // Process emails in batches to avoid memory issues
    const FETCH_BATCH_SIZE = 100;
    for (let i = 0; i < allUids.length; i += FETCH_BATCH_SIZE) {
      const batchUids = allUids.slice(i, i + FETCH_BATCH_SIZE);
      if (batchUids.length === 0) break;

      // Fetch this batch of messages
      for await (const msg of client.fetch(
        batchUids,
        { envelope: true, bodyStructure: true, uid: true },
        { uid: true }
      )) {
      // If resuming, skip messages until we pass the resume point
      // Note: With newest-first, resume logic is different - skip if UID >= resumeAfterUid
      if (resumeAfterUid && msg.uid >= resumeAfterUid) {
        skippedToResume++;
        continue;
      }

      totalEmailsScanned++;
      lastProcessedUid = msg.uid;

      const attachments = extractPdfAttachments(msg.bodyStructure);
      if (attachments.length > 0) {
        totalWithPdf++;
        if (messages.length < maxResults) {
          const pdfMsg = {
            uid: msg.uid,
            subject: msg.envelope.subject,
            from: formatAddress(msg.envelope.from?.[0]),
            date: msg.envelope.date?.toISOString(),
            attachments
          };
          messages.push(pdfMsg);
          pendingMessages.push(pdfMsg);

          // Send batch of PDFs for concurrent processing
          if (pendingMessages.length >= PDF_BATCH_SIZE) {
            sendEvent({
              type: 'pdf_batch',
              messages: pendingMessages.splice(0, pendingMessages.length),
              totalWithPdfSoFar: totalWithPdf
            });
          }
        }
      }

      // Send progress updates periodically
      if ((totalEmailsScanned - previousScanned) % PROGRESS_INTERVAL === 0) {
        // Calculate time estimate
        const elapsed = Date.now() - scanStartTime;
        const scannedThisSession = totalEmailsScanned - previousScanned;
        const emailsPerSecond = scannedThisSession / (elapsed / 1000);
        const remaining = allUids.length - (i + batchUids.length);
        const etaSeconds = emailsPerSecond > 0 ? Math.round(remaining / emailsPerSecond) : null;

        sendEvent({
          type: 'progress',
          scanned: totalEmailsScanned,
          totalInMailbox: allUids.length,
          withPdf: totalWithPdf,
          percentComplete: Math.min(99, Math.round((totalEmailsScanned / allUids.length) * 100)),
          lastUid: lastProcessedUid,
          etaSeconds,
          emailsPerSecond: Math.round(emailsPerSecond)
        });
      }
      } // End of inner for await loop
    } // End of batch loop

    // Send any remaining pending messages
    if (pendingMessages.length > 0) {
      sendEvent({
        type: 'pdf_batch',
        messages: pendingMessages,
        totalWithPdfSoFar: totalWithPdf
      });
    }

    await client.logout();

    // Send final complete event (messages already sent via pdf_batch events)
    sendEvent({
      type: 'complete',
      messages: [], // Messages already streamed via pdf_batch
      totalEmailsScanned,
      totalWithPdf,
      daysBack: effectiveDaysBack,
      lastUid: lastProcessedUid
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
// Processes newest emails first for better UX
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

    // Search for all matching UIDs so we can process newest first
    const searchResult = await client.search({ since: sinceDate }, { uid: true });
    const allUids = Array.isArray(searchResult) ? searchResult : [];

    // Sort UIDs in descending order (newest first)
    allUids.sort((a, b) => b - a);

    const messages = [];
    let totalEmailsScanned = 0;
    let totalWithPdf = 0;

    // Process in batches
    const FETCH_BATCH_SIZE = 100;
    for (let i = 0; i < allUids.length; i += FETCH_BATCH_SIZE) {
      const batchUids = allUids.slice(i, i + FETCH_BATCH_SIZE);
      if (batchUids.length === 0) break;

      for await (const msg of client.fetch(
        batchUids,
        { envelope: true, bodyStructure: true, uid: true },
        { uid: true }
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

// Helper function to collect stream into buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Download attachment using the proper client.download() method
// This handles base64 decoding automatically and returns binary content
app.post('/attachment', async (req, res) => {
  const { email, password, messageUid, partId } = req.body;

  if (!email || !password || !messageUid || !partId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let client = null;
    try {
      client = await createClient(email, password, 30000);
      await client.mailboxOpen('INBOX');

      console.log(`[Attachment] Downloading UID ${messageUid}, part ${partId} (attempt ${attempt})`);

      // Use the proper download() method - this handles base64 decoding automatically
      // and returns a stream of the binary attachment content
      let downloadResult;
      try {
        downloadResult = await client.download(messageUid, partId, { uid: true });
      } catch (downloadErr) {
        console.log(`[Attachment] Direct download failed for part ${partId}: ${downloadErr.message}`);

        // If direct download fails, try to find the correct part by examining structure
        const structMsg = await client.fetchOne(
          messageUid,
          { bodyStructure: true },
          { uid: true }
        );

        if (!structMsg?.bodyStructure) {
          throw new Error('Could not get message structure');
        }

        // Find all PDF parts in the message
        const pdfParts = [];
        function findPdfParts(part, path = '') {
          // Build the correct part path
          // Root level multipart doesn't have a part number
          // First child is "1", second is "2", etc.
          // Nested parts are "1.1", "1.2", "2.1", etc.

          const mimeType = `${part.type || ''}/${part.subtype || ''}`.toLowerCase();
          const filename = part.dispositionParameters?.filename || part.parameters?.name || '';

          if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
            pdfParts.push({
              path: path || '1',
              filename,
              size: part.size,
              encoding: part.encoding
            });
          }

          if (part.childNodes) {
            part.childNodes.forEach((child, idx) => {
              const childPath = path ? `${path}.${idx + 1}` : `${idx + 1}`;
              findPdfParts(child, childPath);
            });
          }
        }
        findPdfParts(structMsg.bodyStructure);

        console.log(`[Attachment] Found PDF parts: ${JSON.stringify(pdfParts)}`);

        if (pdfParts.length === 0) {
          throw new Error('No PDF attachments found in message');
        }

        // Try each PDF part until we find one that works
        let foundPdf = false;
        for (const pdfPart of pdfParts) {
          try {
            console.log(`[Attachment] Trying PDF part ${pdfPart.path} (${pdfPart.filename})`);
            downloadResult = await client.download(messageUid, pdfPart.path, { uid: true });
            foundPdf = true;
            break;
          } catch (partErr) {
            console.log(`[Attachment] Part ${pdfPart.path} failed: ${partErr.message}`);
          }
        }

        if (!foundPdf) {
          throw new Error('Could not download any PDF attachment');
        }
      }

      if (!downloadResult || !downloadResult.content) {
        throw new Error('No content returned from download');
      }

      // Collect the stream into a buffer
      const buffer = await streamToBuffer(downloadResult.content);

      if (buffer.length === 0) {
        throw new Error('Downloaded attachment is empty');
      }

      // Validate it's a PDF by checking magic bytes
      // PDF files start with %PDF (hex: 25 50 44 46)
      const isPdf = buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;

      if (!isPdf) {
        // Log what we actually got for debugging
        const preview = buffer.slice(0, 100).toString('utf-8');
        console.error(`[Attachment] Downloaded content is not a PDF. Preview: ${preview}`);
        throw new Error(`Downloaded content is not a valid PDF (got ${buffer.length} bytes, starts with: ${preview.substring(0, 50)})`);
      }

      console.log(`[Attachment] Successfully downloaded PDF: ${buffer.length} bytes`);

      // Convert to base64 for JSON response
      const base64 = buffer.toString('base64');

      await client.logout();
      return res.json({
        base64,
        filename: downloadResult.meta?.filename || 'document.pdf',
        size: buffer.length
      });
    } catch (err) {
      lastError = err;
      console.error(`[Attachment] Download error (attempt ${attempt}):`, err.message);
      if (client) try { await client.logout(); } catch {}

      // Wait before retry with exponential backoff
      if (attempt < MAX_RETRIES) {
        const waitMs = 1000 * Math.pow(2, attempt - 1);
        console.log(`[Attachment] Waiting ${waitMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  console.error(`[Attachment] All retries failed for UID ${messageUid}, part ${partId}:`, lastError?.message);
  res.status(500).json({ error: lastError?.message || 'Download failed after retries' });
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
// Part numbering for IMAP BODYSTRUCTURE:
// - For simple messages: part "1" is the body
// - For multipart messages: children are numbered "1", "2", "3", etc.
// - Nested parts are "1.1", "1.2", "2.1", etc.
function extractPdfAttachments(bodyStructure) {
  const attachments = [];

  function walk(part, path = '') {
    if (!part) return;

    const mimeType = `${part.type || ''}/${part.subtype || ''}`.toLowerCase();
    const filename = part.dispositionParameters?.filename ||
                     part.parameters?.name || '';

    // For non-multipart, the part ID is the path or "1" if root
    const isMultipart = mimeType.startsWith('multipart/');

    if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      attachments.push({
        filename: filename || 'document.pdf',
        mimeType,
        size: part.size || 0,
        partId: path || '1',
        encoding: part.encoding
      });
    }

    if (part.childNodes) {
      part.childNodes.forEach((child, index) => {
        // Child numbering starts at 1
        const childPath = path ? `${path}.${index + 1}` : `${index + 1}`;
        walk(child, childPath);
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
