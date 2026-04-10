const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_ALLOWED_ORIGINS = ['https://christopher-c-robinson.github.io'];
const DEFAULT_SUPPORT_URL = 'https://christopher-c-robinson.github.io/Christopher-C-Robinson/projects/bingoflow/support/';
const DEFAULT_RECEIPT_URL = 'https://christopher-c-robinson.github.io/Christopher-C-Robinson/projects/bingoflow/support/receipt/';
const DEFAULT_SUPPORT_LABELS = ['support'];

let cachedPrivateKeyPromise;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (request.method === 'GET') {
      return htmlResponse(renderHealthPage(url, env));
    }

    if (request.method !== 'POST') {
      return methodNotAllowed();
    }

    const originCheck = getAllowedOrigin(request, env);
    if (!originCheck.ok) {
      return htmlResponse(
        renderMessagePage({
          title: 'Support request blocked',
          heading: 'Support request blocked',
          body: 'The support form must be submitted from the public BingoFlow site.',
          note: 'If you reached this page another way, go back to the support form and try again.',
          ctaHref: getSupportUrl(env),
          ctaLabel: 'Open support form',
        }),
        403,
      );
    }

    const payload = await readPayload(request);
    const honeypot = readText(payload.website) || readText(payload.company) || readText(payload.url);
    if (honeypot) {
      return htmlResponse(
        renderMessagePage({
          title: 'Submission rejected',
          heading: 'Submission rejected',
          body: 'This submission looked automated, so it was not forwarded.',
          note: 'Return to the support form and try again if you are a real user.',
          ctaHref: getSupportUrl(env),
          ctaLabel: 'Open support form',
        }),
        400,
      );
    }

    const title = truncate(normalizeText(readText(payload.title)), 120);
    const details = truncate(normalizeMultiline(readText(payload.details)), 8000);
    const email = normalizeEmail(readText(payload.email));

    if (!title || !details) {
      return htmlResponse(
        renderMessagePage({
          title: 'Missing details',
          heading: 'Missing details',
          body: 'A support title and details are required before we can create the private issue.',
          note: 'Please return to the public support form and fill out both required fields.',
          ctaHref: getSupportUrl(env),
          ctaLabel: 'Open support form',
        }),
        400,
      );
    }

    if (email && !isEmail(email)) {
      return htmlResponse(
        renderMessagePage({
          title: 'Invalid email',
          heading: 'Invalid email',
          body: 'The email address you entered does not look valid.',
          note: 'Leave the email field blank if you do not want follow-up.',
          ctaHref: getSupportUrl(env),
          ctaLabel: 'Open support form',
        }),
        400,
      );
    }

    const submissionId = makeSubmissionId();
    const submittedAt = new Date().toISOString();
    const supportPage = request.headers.get('Referer') || url.toString();
    const userAgent = request.headers.get('User-Agent') || 'unknown';
    const sourceOrigin = originCheck.origin || 'unknown';

    const issueTitle = `BingoFlow support: ${title}`;
    const issueBody = buildIssueBody({
      details,
      email,
      submissionId,
      submittedAt,
      supportPage,
      sourceOrigin,
      userAgent,
    });

    const token = await getInstallationToken(env);
    const issue = await createIssue(token, env, issueTitle, issueBody);
    const labels = parseCsv(env.SUPPORT_LABELS || DEFAULT_SUPPORT_LABELS.join(','));

    if (labels.length > 0) {
      await applyLabels(token, env, issue.number, labels).catch((error) => {
        console.warn('Could not apply support labels:', error?.message || error);
      });
    }

    const receiptUrl = new URL(getReceiptUrl(env));
    receiptUrl.searchParams.set('ticket', String(issue.number));
    receiptUrl.searchParams.set('request', submissionId);
    receiptUrl.searchParams.set('title', title);

    return Response.redirect(receiptUrl.toString(), 303);
  },
};

async function readPayload(request) {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return request.json();
  }

  const formData = await request.formData();
  const payload = {};

  for (const [key, value] of formData.entries()) {
    payload[key] = typeof value === 'string' ? value : '';
  }

  return payload;
}

function getReceiptUrl(env) {
  return env.RECEIPT_URL || DEFAULT_RECEIPT_URL;
}

function getSupportUrl(env) {
  return env.SUPPORT_URL || DEFAULT_SUPPORT_URL;
}

function getAllowedOrigin(request, env) {
  const allowedOrigins = parseCsv(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','));
  const origin = request.headers.get('Origin');

  if (origin && allowedOrigins.includes(origin)) {
    return { ok: true, origin };
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (allowedOrigins.includes(refererOrigin)) {
        return { ok: true, origin: refererOrigin };
      }
    } catch {
      // Ignore malformed referers and fall through to rejection.
    }
  }

  return { ok: false, origin: origin || null };
}

async function getInstallationToken(env) {
  const appId = readText(env.GITHUB_APP_ID);
  const installationId = readText(env.GITHUB_INSTALLATION_ID);

  if (!appId || !installationId) {
    throw new Error('Missing GITHUB_APP_ID or GITHUB_INSTALLATION_ID');
  }

  const jwt = await createGithubAppJwt(appId, readText(env.GITHUB_PRIVATE_KEY));
  const response = await githubFetch(
    `app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
    null,
  );

  if (!response.ok) {
    throw new Error(`Failed to mint installation token: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.token) {
    throw new Error('GitHub did not return an installation token');
  }

  return data.token;
}

async function createIssue(token, env, title, body) {
  const owner = readText(env.GITHUB_REPO_OWNER);
  const repo = readText(env.GITHUB_REPO_NAME);

  if (!owner || !repo) {
    throw new Error('Missing GITHUB_REPO_OWNER or GITHUB_REPO_NAME');
  }

  const response = await githubFetch(
    `repos/${owner}/${repo}/issues`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {
        title,
        body,
      },
    },
    env,
  );

  if (!response.ok) {
    throw new Error(`Failed to create issue: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function applyLabels(token, env, issueNumber, labels) {
  const owner = readText(env.GITHUB_REPO_OWNER);
  const repo = readText(env.GITHUB_REPO_NAME);

  const usableLabels = [];
  for (const label of labels) {
    const name = readText(label);
    if (!name) {
      continue;
    }

    try {
      await ensureLabel(token, owner, repo, name);
      usableLabels.push(name);
    } catch (error) {
      console.warn(`Skipping label ${name}:`, error?.message || error);
    }
  }

  if (usableLabels.length === 0) {
    return;
  }

  const response = await githubFetch(
    `repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {
        labels: usableLabels,
      },
    },
    env,
  );

  if (!response.ok) {
    throw new Error(`Failed to apply labels: ${response.status} ${await response.text()}`);
  }
}

async function ensureLabel(token, owner, repo, name) {
  const lookup = await githubFetch(
    `repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    null,
  );

  if (lookup.ok) {
    return;
  }

  if (lookup.status !== 404) {
    throw new Error(`Unexpected label lookup failure: ${lookup.status} ${await lookup.text()}`);
  }

  const create = await githubFetch(
    `repos/${owner}/${repo}/labels`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {
        name,
        color: '0f766e',
        description: 'Submitted through the public BingoFlow support form',
      },
    },
    null,
  );

  if (!create.ok && create.status !== 422) {
    throw new Error(`Failed to create label: ${create.status} ${await create.text()}`);
  }
}

async function githubFetch(path, options = {}, env) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION);
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const init = {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  };

  return fetch(`${GITHUB_API_BASE}/${path}`, init);
}

async function createGithubAppJwt(appId, privateKeyPem) {
  if (!privateKeyPem) {
    throw new Error('Missing GITHUB_PRIVATE_KEY');
  }

  const key = await getPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlEncodeJson({
    iat: now - 30,
    exp: now + 540,
    iss: appId,
  });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(input),
  );

  return `${input}.${base64UrlEncodeBytes(signature)}`;
}

async function getPrivateKey(privateKeyPem) {
  if (!cachedPrivateKeyPromise) {
    cachedPrivateKeyPromise = (async () => {
      const keyData = pemToArrayBuffer(privateKeyPem);
      return crypto.subtle.importKey(
        'pkcs8',
        keyData,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    })();
  }

  return cachedPrivateKeyPromise;
}

function pemToArrayBuffer(pem) {
  const normalized = pem
    .replace(/-----(BEGIN|END) [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  return bytes.buffer;
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildIssueBody({ details, email, submissionId, submittedAt, supportPage, sourceOrigin, userAgent }) {
  return [
    'A support request was submitted through the public BingoFlow support page.',
    '',
    '## User report',
    blockquote(details),
    '',
    '## Metadata',
    `- Submission ID: ${submissionId}`,
    `- Submitted at: ${submittedAt}`,
    `- Support page: ${supportPage}`,
    `- Origin: ${sourceOrigin}`,
    `- User agent: ${userAgent}`,
    `- Contact email: ${email || 'Not provided'}`,
  ].join('\n');
}

function blockquote(text) {
  return normalizeMultiline(text)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function renderHealthPage(url, env) {
  const owner = readText(env.GITHUB_REPO_OWNER) || 'unknown';
  const repo = readText(env.GITHUB_REPO_NAME) || 'unknown';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BingoFlow Support Worker</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f172a;
      color: #e2e8f0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 24px;
    }
    main {
      max-width: 720px;
      width: 100%;
      padding: 28px;
      border-radius: 24px;
      background: rgba(15, 23, 42, 0.82);
      border: 1px solid rgba(148, 163, 184, 0.18);
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.4);
    }
    code {
      background: rgba(148, 163, 184, 0.14);
      padding: 0.2rem 0.4rem;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <main>
    <h1>BingoFlow support worker is live</h1>
    <p>This worker receives public support submissions and creates private issues in <code>${owner}/${repo}</code>.</p>
    <p>Current path: <code>${url.pathname}</code></p>
    <p>Send a <code>POST /submit</code> request from the public support page to create a private issue.</p>
  </main>
</body>
</html>`;
}

function renderMessagePage({ title, heading, body, note, ctaHref, ctaLabel }) {
  const safeTitle = escapeHtml(title);
  const safeHeading = escapeHtml(heading);
  const safeBody = escapeHtml(body);
  const safeNote = escapeHtml(note);
  const safeHref = escapeHtml(ctaHref);
  const safeLabel = escapeHtml(ctaLabel);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f8fafc;
      color: #0f172a;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 24px;
    }
    main {
      max-width: 720px;
      width: 100%;
      padding: 28px;
      border-radius: 24px;
      background: #ffffff;
      border: 1px solid rgba(15, 23, 42, 0.12);
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
    }
    a {
      display: inline-flex;
      margin-top: 18px;
      padding: 12px 18px;
      border-radius: 999px;
      background: #0f172a;
      color: #fff;
      text-decoration: none;
      font-weight: 700;
    }
    p:last-of-type {
      color: #475569;
    }
  </style>
</head>
<body>
  <main>
    <h1>${safeHeading}</h1>
    <p>${safeBody}</p>
    <p>${safeNote}</p>
    <a href="${safeHref}">${safeLabel}</a>
  </main>
</body>
</html>`;
}

function renderErrorPage(message) {
  return renderMessagePage({
    title: 'BingoFlow support error',
    heading: 'Something went wrong',
    body: message,
    note: 'Please go back to the public support form and try again, or use the contact email on the site if the problem continues.',
    ctaHref: DEFAULT_SUPPORT_URL,
    ctaLabel: 'Back to support',
  });
}

function methodNotAllowed() {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: {
      Allow: 'GET, POST, OPTIONS',
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function corsHeaders(request, env) {
  const originCheck = getAllowedOrigin(request, env);
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };

  if (originCheck.ok) {
    headers['access-control-allow-origin'] = originCheck.origin;
    headers['vary'] = 'Origin';
  }

  return headers;
}

function parseCsv(value) {
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readText(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function normalizeText(value) {
  return readText(value).replace(/\s+/g, ' ');
}

function normalizeMultiline(value) {
  return readText(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function normalizeEmail(value) {
  return readText(value).toLowerCase();
}

function truncate(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function makeSubmissionId() {
  return `BF-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomUUID().slice(0, 8)}`;
}

function escapeHtml(value) {
  return readText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
