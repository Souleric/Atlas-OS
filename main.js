const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');

const CLAUDE_BIN = '/usr/local/bin/claude';

// ===== IPC: MULTI-MODEL AI =====
ipcMain.handle('atlas:ask', async (_, { system, messages, agentId }) => {
  // For now, always use Claude CLI as default
  // Future: Route to GPT-4o or Gemini based on agentConfig
  
  return new Promise((resolve) => {
    // Build a single prompt: system + conversation history + new message
    let prompt = '';
    if (system) prompt += `<system>\n${system}\n</system>\n\n`;
    const prior = messages.slice(0, -1);
    if (prior.length) {
      prior.forEach(m => {
        prompt += `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}\n\n`;
      });
    }
    const last = messages[messages.length - 1];
    prompt += `Human: ${last.content}`;

    let output = '';
    let errout = '';
    const child = spawn(CLAUDE_BIN, ['--print', '--model', 'claude-sonnet-4-5'], {
      env: { ...process.env, HOME: process.env.HOME },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { errout += d.toString(); });
    child.on('close', code => {
      if (code === 0 && output.trim()) {
        resolve({ ok: true, text: output.trim() });
      } else {
        resolve({ ok: false, error: errout.trim() || `claude exited with code ${code}` });
      }
    });
    child.on('error', err => {
      resolve({ ok: false, error: err.message });
    });
  });
});

// Prevent socket timeouts and other async IMAP errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

// ===== ACCOUNT FILE =====
function accountsFile() { return path.join(app.getPath('userData'), 'email-accounts.json'); }
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(accountsFile(), 'utf8')); }
  catch { return []; }
}
function saveAccounts(accounts) { fs.writeFileSync(accountsFile(), JSON.stringify(accounts, null, 2)); }

// ===== IPC: ACCOUNTS =====
ipcMain.handle('email:get-accounts', () => {
  return loadAccounts().map(a => ({ ...a, password: '***' })); // strip password
});

ipcMain.handle('email:add-account', async (_, data) => {
  const accounts = loadAccounts();
  if (accounts.length >= 10) return { ok: false, error: 'Maximum 10 accounts reached' };
  const account = { ...data, id: 'acc_' + Date.now() };
  accounts.push(account);
  saveAccounts(accounts);
  return { ok: true, account: { ...account, password: '***' } };
});

ipcMain.handle('email:remove-account', (_, id) => {
  const accounts = loadAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
  return { ok: true };
});

ipcMain.handle('email:test-account', async (_, data) => {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: data.imapHost, port: parseInt(data.imapPort),
    secure: data.imapPort == 993,
    auth: { user: data.email, pass: data.password },
    logger: false, tls: { rejectUnauthorized: false }, socketTimeout: 15000, connectionTimeout: 15000
  });
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ===== IPC: FETCH MESSAGES =====
ipcMain.handle('email:fetch-messages', async (_, { accountId, mailbox = 'INBOX', limit = 50 }) => {
  const { ImapFlow } = require('imapflow');
  const all = loadAccounts();
  const accounts = accountId ? all.filter(a => a.id === accountId) : all;
  const allMessages = [];

  for (const account of accounts) {
    const client = new ImapFlow({
      host: account.imapHost, port: parseInt(account.imapPort),
      secure: account.imapPort == 993,
      auth: { user: account.email, pass: account.password },
      logger: false, tls: { rejectUnauthorized: false }, socketTimeout: 15000, connectionTimeout: 15000
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const total = client.mailbox.exists;
        if (total === 0) continue;
        const from = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${from}:*`, {
          uid: true, flags: true, envelope: true, bodyStructure: true
        })) {
          const f = msg.envelope.from?.[0] || {};
          const fromAddress = (f.mailbox && f.host) ? f.mailbox + '@' + f.host : (f.mailbox || f.host || account.email);
          allMessages.push({
            uid: msg.uid,
            accountId: account.id,
            accountEmail: account.email,
            mailbox,
            from: { name: f.name || '', address: fromAddress },
            subject: msg.envelope.subject || '(no subject)',
            date: msg.envelope.date?.toISOString() || new Date().toISOString(),
            seen: msg.flags.has('\\Seen'),
            flagged: msg.flags.has('\\Flagged'),
            preview: '',
          });
        }
      } finally { lock.release(); }
      await client.logout();
    } catch(e) {
      console.error('[IMAP]', account.email, e.message);
      allMessages.push({ error: true, accountEmail: account.email, errorMsg: e.message });
    }
  }
  allMessages.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { messages: allMessages };
});

// ===== IPC: FETCH BODY =====
ipcMain.handle('email:fetch-body', async (_, { accountId, mailbox, uid }) => {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const account = loadAccounts().find(a => a.id === accountId);
  if (!account) return { error: 'Account not found' };
  const client = new ImapFlow({
    host: account.imapHost, port: parseInt(account.imapPort),
    secure: account.imapPort == 993,
    auth: { user: account.email, pass: account.password },
    logger: false, tls: { rejectUnauthorized: false }, socketTimeout: 15000, connectionTimeout: 15000
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox || 'INBOX');
    let text = '', html = '';
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      text = parsed.text || '';
      html = parsed.html || '';
    } finally { lock.release(); }
    await client.logout();
    return { text, html };
  } catch(e) { return { error: e.message }; }
});

// ===== IPC: SEND =====
ipcMain.handle('email:send', async (_, { accountId, to, subject, text, inReplyTo, cc, bcc }) => {
  const nodemailer = require('nodemailer');
  const account = loadAccounts().find(a => a.id === accountId);
  if (!account) return { ok: false, error: 'Account not found' };
  const transporter = nodemailer.createTransport({
    host: account.smtpHost, port: parseInt(account.smtpPort),
    secure: account.smtpPort == 465,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: false }
  });
  try {
    const info = await transporter.sendMail({
      from: `${account.label || ''} <${account.email}>`,
      to, subject, text,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {})
    });
    return { ok: true, messageId: info.messageId };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ===== IPC: MARK READ =====
ipcMain.handle('email:mark-read', async (_, { accountId, mailbox, uid }) => {
  const { ImapFlow } = require('imapflow');
  const account = loadAccounts().find(a => a.id === accountId);
  if (!account) return { ok: false };
  const client = new ImapFlow({
    host: account.imapHost, port: parseInt(account.imapPort),
    secure: account.imapPort == 993,
    auth: { user: account.email, pass: account.password },
    logger: false, tls: { rejectUnauthorized: false }, socketTimeout: 15000, connectionTimeout: 15000
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox || 'INBOX');
    try { await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); }
    finally { lock.release(); }
    await client.logout();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ===== WINDOW =====
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Atlas OS',
    backgroundColor: '#0d0d0f',
  });

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://api.anthropic.com/*'] },
    (details, callback) => {
      details.requestHeaders['Origin'] = 'https://atlas-os.local';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  win.loadFile('atlas-os_2.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
